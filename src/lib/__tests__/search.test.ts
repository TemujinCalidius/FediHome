import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { authenticateApiRequest } = vi.hoisted(() => ({ authenticateApiRequest: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest }));
vi.mock("@/lib/db", () => ({
  prisma: { post: { findMany: vi.fn() }, photo: { findMany: vi.fn() } },
}));

import { GET } from "@/app/api/search/route";
import { prisma } from "@/lib/db";

const ok = { ok: true, via: "bearer", scope: "read" };
const no = { ok: false, via: null, scope: "" };

function req(params: Record<string, string>): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TRUSTED_PROXY;
  vi.mocked(prisma.post.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.photo.findMany).mockResolvedValue([] as never);
});

describe("GET /api/search", () => {
  it("401 without a read scope", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await GET(req({ q: "hello" }))).status).toBe(401);
    expect(authenticateApiRequest).toHaveBeenCalledWith(expect.anything(), "read");
  });

  it("returns empty for a too-short query without hitting the DB", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    const body = await (await GET(req({ q: "a" }))).json();
    expect(body.results).toEqual([]);
    expect(prisma.post.findMany).not.toHaveBeenCalled();
    expect(prisma.photo.findMany).not.toHaveBeenCalled();
  });

  it("only ever queries PUBLISHED rows (never drafts)", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    await GET(req({ q: "hello" }));
    const postArg = vi.mocked(prisma.post.findMany).mock.calls[0][0];
    const photoArg = vi.mocked(prisma.photo.findMany).mock.calls[0][0];
    expect(postArg?.where?.published).toBe(true);
    expect(photoArg?.where?.published).toBe(true);
  });

  it("merges post + photo results with normalized shape, newest first", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    vi.mocked(prisma.post.findMany).mockResolvedValue([
      { slug: "hi", title: "Hi", content: "c", contentHtml: "<p>c</p>", excerpt: "an excerpt", category: "note", publishedAt: new Date("2026-01-02") },
    ] as never);
    vi.mocked(prisma.photo.findMany).mockResolvedValue([
      { slug: "pic", title: "Pic", caption: "a caption", category: "wildlife", publishedAt: new Date("2026-01-03") },
    ] as never);
    const body = await (await GET(req({ q: "hello" }))).json();
    expect(body.results.map((r: { type: string }) => r.type)).toEqual(["photo", "post"]); // newest first
    expect(body.results[1]).toMatchObject({ type: "post", slug: "hi", url: "/post/hi", snippet: "an excerpt" });
    expect(body.results[0]).toMatchObject({ type: "photo", url: "/photography/pic", snippet: "a caption" });
  });

  it("type=post skips the photo query", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    await GET(req({ q: "hello", type: "post" }));
    expect(prisma.post.findMany).toHaveBeenCalled();
    expect(prisma.photo.findMany).not.toHaveBeenCalled();
  });
});
