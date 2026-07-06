import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { authenticateApiRequest } = vi.hoisted(() => ({ authenticateApiRequest: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest }));
vi.mock("@/lib/db", () => ({ prisma: { post: { findMany: vi.fn() } } }));

import { GET } from "@/app/api/posts/route";
import { prisma } from "@/lib/db";

const ok = { ok: true, via: "bearer", scope: "read" };
const no = { ok: false, via: null, scope: "" };

function req(params: Record<string, string> = {}): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as unknown as NextRequest;
}

const row = (over: Record<string, unknown> = {}) => ({
  id: "post_1", slug: "hello", title: "Hello", excerpt: "x", category: "article",
  photos: [], videos: [], audioPaths: [],
  published: true, publishedAt: new Date("2026-01-02"), updatedAt: new Date("2026-01-03"),
  scheduledFor: null,
  likeCount: 2, boostCount: 1, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.post.findMany).mockResolvedValue([] as never);
});

describe("GET /api/posts (My Posts)", () => {
  it("401 without a read scope", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await GET(req())).status).toBe(401);
    expect(authenticateApiRequest).toHaveBeenCalledWith(expect.anything(), "read");
  });

  it("returns the owner's posts with derived type + media counts + relative url", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    vi.mocked(prisma.post.findMany).mockResolvedValue([
      row(),
      row({ slug: "pics", category: "note", photos: ["a", "b"] }),
    ] as never);
    const body = await (await GET(req())).json();
    expect(body.posts).toHaveLength(2);
    expect(body.posts[0]).toMatchObject({ id: "post_1", slug: "hello", url: "/post/hello", type: "article", counts: { likes: 2, boosts: 1 } });
    expect(body.posts[1]).toMatchObject({ type: "photo", media: { photos: 2, videos: 0, audio: 0 } });
  });

  it("status=draft filters to unpublished with NO scheduledFor", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    await GET(req({ status: "draft" }));
    expect(vi.mocked(prisma.post.findMany).mock.calls[0][0]?.where).toMatchObject({
      published: false,
      scheduledFor: null,
    });
  });

  it("status=scheduled filters to unpublished WITH a scheduledFor set (#183)", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    await GET(req({ status: "scheduled" }));
    expect(vi.mocked(prisma.post.findMany).mock.calls[0][0]?.where).toMatchObject({
      published: false,
      scheduledFor: { not: null },
    });
  });

  it("exposes scheduledFor + a derived 'scheduled' status (#183)", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    vi.mocked(prisma.post.findMany).mockResolvedValue([
      row({ slug: "later", published: false, scheduledFor: new Date("2026-09-01") }),
    ] as never);
    const body = await (await GET(req())).json();
    expect(body.posts[0].status).toBe("scheduled");
    expect(body.posts[0].scheduledFor).toBe(new Date("2026-09-01").toISOString());
  });

  it("a legacy plain-ISO cursor still paginates (backward-compatible strict lt)", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    await GET(req({ type: "photo", cursor: "2026-01-01T00:00:00.000Z" }));
    const where = vi.mocked(prisma.post.findMany).mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where.photos).toEqual({ isEmpty: false });
    expect(where.publishedAt).toHaveProperty("lt");
  });

  it("a compound cursor seeks on (publishedAt, id) — the #206 tiebreak", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    await GET(req({ cursor: "2026-01-04T00:00:00.000Z_post_9" }));
    const where = vi.mocked(prisma.post.findMany).mock.calls[0][0]?.where as { OR: unknown[] };
    expect(where.OR).toEqual([
      { publishedAt: { lt: new Date("2026-01-04T00:00:00.000Z") } },
      { publishedAt: new Date("2026-01-04T00:00:00.000Z"), id: { lt: "post_9" } },
    ]);
  });

  it("caps the limit and sets a compound nextCursor when there are more", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    // 3 rows with limit=2 → hasMore, page of 2, nextCursor from the 2nd
    vi.mocked(prisma.post.findMany).mockResolvedValue([
      row({ id: "a", slug: "a", publishedAt: new Date("2026-01-05") }),
      row({ id: "b", slug: "b", publishedAt: new Date("2026-01-04") }),
      row({ id: "c", slug: "c", publishedAt: new Date("2026-01-03") }),
    ] as never);
    const body = await (await GET(req({ limit: "2" }))).json();
    expect(body.posts).toHaveLength(2);
    expect(body.nextCursor).toBe(`${new Date("2026-01-04").toISOString()}_b`);
    expect(vi.mocked(prisma.post.findMany).mock.calls[0][0]?.take).toBe(3); // limit + 1
    // Order is (publishedAt desc, id desc) so the tiebreak is total.
    expect(vi.mocked(prisma.post.findMany).mock.calls[0][0]?.orderBy).toEqual([
      { publishedAt: "desc" }, { id: "desc" },
    ]);
  });
});
