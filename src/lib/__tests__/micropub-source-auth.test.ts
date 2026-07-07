import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  verifyMicropubToken: verify,
  hasScope: (s: string | undefined, r: string) => (s ?? "").split(/\s+/).includes(r),
}));
vi.mock("@/lib/audit", () => ({ recordTokenUse: vi.fn() }));
vi.mock("@/lib/publish-post", () => ({ publishPost: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { post: { findUnique: vi.fn() } } }));

import { GET } from "@/app/api/micropub/route";
import { prisma } from "@/lib/db";

function sourceReq(withToken: boolean): NextRequest {
  return new NextRequest("https://x/api/micropub?q=source&url=/post/secret-draft", {
    headers: withToken ? { authorization: "Bearer t" } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.post.findUnique).mockResolvedValue({
    slug: "secret-draft",
    title: "Secret",
    content: "unpublished body",
    excerpt: null,
    tags: [],
    published: false,
    publishedAt: new Date("2026-07-01T00:00:00Z"),
  } as never);
});

describe("Micropub q=source auth (draft disclosure fix)", () => {
  it("rejects an unauthenticated q=source request without reading the post", async () => {
    verify.mockResolvedValue({ valid: false });
    const res = await GET(sourceReq(false));
    expect(res.status).toBe(401);
    // The draft must never be looked up, let alone returned.
    expect(prisma.post.findUnique).not.toHaveBeenCalled();
  });

  it("returns the source for a valid owner token", async () => {
    verify.mockResolvedValue({ valid: true, scope: "create update delete media" });
    const res = await GET(sourceReq(true));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.properties.content).toEqual(["unpublished body"]);
  });
});
