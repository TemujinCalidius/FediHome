import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * `/xmlrpc` token verification.
 *
 * This route had **no test at all**, which is how it kept its own verifier:
 *
 * ```ts
 * async function verifyAuth(password: string): Promise<boolean> {
 *   const token = await prisma.authToken.findUnique({ where: { tokenHash: hash } });
 *   return !!token;                                     // existence, and nothing else
 * }
 * ```
 *
 * Every other bearer path goes through the shared verifier, which rejects expired
 * tokens and returns `scope`. So `/xmlrpc` alone honoured neither. Two consequences,
 * both reachable by anyone holding any token:
 *
 *  - **scope escalation** — a token narrowed to `read` in /admin/apps could still
 *    `newPost` and `deletePost`, and delete federates a `Delete` that remote servers
 *    act on. The admin UI promises "a reduced scope takes effect on the token's next
 *    request". Over XML-RPC that was untrue.
 *  - **expiry bypass** — `expiresAt` was never read, so an expired token kept working.
 *
 * The compatibility trap these tests pin: `AuthToken.scope` has defaulted to
 * `"create update delete media"` since the first release, so legacy hand-issued
 * tokens have create and delete but NOT `read`. Gating the writes breaks nobody;
 * gating the reads would break every existing micro.blog setup.
 */

const { verifyTokenValue } = vi.hoisted(() => ({ verifyTokenValue: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  verifyTokenValue,
  // The REAL hasScope, so scope logic is genuinely exercised rather than mocked.
  hasScope: (scope: string | undefined, required: string) =>
    (scope ?? "").split(/\s+/).includes(required),
}));

const { deletePostWithFederation } = vi.hoisted(() => ({ deletePostWithFederation: vi.fn() }));
vi.mock("@/lib/delete-post", () => ({ deletePostWithFederation }));
vi.mock("@/lib/audit", () => ({ recordTokenUse: vi.fn() }));
vi.mock("@/lib/sanitize", () => ({ sanitizeHtml: (s: string) => s }));
vi.mock("@/lib/identity", () => ({ getSiteUrl: () => "https://demo.example" }));
vi.mock("@/lib/ap-post", () => ({ buildPostObject: vi.fn() }));
// newPost dynamically imports these and calls .catch() on the result, so they must
// resolve rather than return undefined.
vi.mock("@/lib/http-signatures", () => ({ deliverToFollowers: vi.fn(async () => {}) }));
vi.mock("@/lib/crosspost", () => ({
  crosspostToBluesky: vi.fn(async () => {}),
  crosspostToThreads: vi.fn(async () => {}),
}));
// `rateBuckets` is module-level with a 10-request/60s cap, so without a unique key
// per request the 11th test in this file would 429 instead of exercising the route.
let reqCounter = 0;
vi.mock("@/lib/client-ip", () => ({ rateLimitKey: () => `test-${reqCounter}` }));
vi.mock("@/lib/db", () => ({
  prisma: {
    post: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

import { POST } from "@/app/xmlrpc/route";
import { prisma } from "@/lib/db";

/** The scope every hand-issued token has carried since the first release. */
const LEGACY_SCOPE = "create update delete media";

/** An XML-RPC call with the token in param index 2, the MetaWeblog password slot. */
const call = (method: string, params: string[]): NextRequest => {
  reqCounter++;
  const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params
    .map((p) => `<param><value><string>${p}</string></value></param>`)
    .join("")}</params></methodCall>`;
  return {
    text: async () => body,
    method: "POST",
    nextUrl: { pathname: "/xmlrpc" },
    headers: new Headers(),
  } as unknown as NextRequest;
};

const del = (token: string, postId = "p1") => call("metaWeblog.deletePost", ["1", postId, token]);
const create = (token: string) =>
  call("metaWeblog.newPost", ["1", "user", token, "<title>t</title>"]);

const text = (res: Response) => res.text();

beforeEach(() => {
  vi.clearAllMocks();
  verifyTokenValue.mockResolvedValue({ valid: true, scope: LEGACY_SCOPE, tokenId: "t1" });
  vi.mocked(prisma.post.findUnique).mockResolvedValue({ id: "p1", slug: "s", published: true } as never);
  vi.mocked(prisma.post.findFirst).mockResolvedValue({ id: "p1", slug: "s", title: "T", content: "c" } as never);
  vi.mocked(prisma.post.create).mockResolvedValue({
    id: "new", slug: "s", title: "t", content: "c",
    published: true, publishedAt: new Date("2026-07-31T00:00:00Z"), apId: null,
  } as never);
  vi.mocked(prisma.post.findMany).mockResolvedValue([] as never);
});

describe("the shared verifier is used at all", () => {
  it("rejects an invalid token", async () => {
    verifyTokenValue.mockResolvedValue({ valid: false });
    expect(await text(await POST(del("bad")))).toContain("Authentication failed");
    expect(deletePostWithFederation).not.toHaveBeenCalled();
  });

  it("rejects an EXPIRED token — the route used to accept one forever", async () => {
    // verifyTokenValue is what enforces expiresAt; the old local verifyAuth never
    // read it, so an expired token kept working until something swept the row.
    verifyTokenValue.mockResolvedValue({ valid: false }); // what an expired token yields
    expect(await text(await POST(del("expired")))).toContain("Authentication failed");
  });

  it("passes the raw password param to the verifier, not a Bearer header", async () => {
    await POST(del("tok-123"));
    expect(verifyTokenValue).toHaveBeenCalledWith("tok-123");
  });

  it("leaves the discovery methods open and unauthenticated", async () => {
    const res = await POST(call("system.listMethods", []));
    expect(await text(res)).toContain("metaWeblog.newPost");
    expect(verifyTokenValue).not.toHaveBeenCalled();
  });
});

describe("scope gating on the write methods", () => {
  it("REFUSES delete for a read-only token", async () => {
    // The escalation: /admin/apps will mint exactly this, and the admin UI says a
    // reduced scope takes effect on the next request.
    verifyTokenValue.mockResolvedValue({ valid: true, scope: "read", tokenId: "t1" });
    expect(await text(await POST(del("t")))).toMatch(/not allowed to delete/);
    expect(deletePostWithFederation).not.toHaveBeenCalled();
  });

  it("REFUSES create for a read-only token", async () => {
    verifyTokenValue.mockResolvedValue({ valid: true, scope: "read", tokenId: "t1" });
    expect(await text(await POST(create("t")))).toMatch(/not allowed to create/);
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it("still lets a LEGACY token create and delete — the compatibility guarantee", async () => {
    // If this ever fails, every micro.blog user who pasted a token in years ago
    // has silently stopped being able to post.
    expect(await text(await POST(create("t")))).not.toMatch(/not allowed/);
    expect(prisma.post.create).toHaveBeenCalled();

    await POST(del("t"));
    expect(deletePostWithFederation).toHaveBeenCalled();
  });

  it("does NOT gate the read methods, which legacy tokens have no scope for", async () => {
    // LEGACY_SCOPE lacks `read`. Gating these would break every existing client,
    // and /api/micropub doesn't gate reads either.
    verifyTokenValue.mockResolvedValue({ valid: true, scope: LEGACY_SCOPE, tokenId: "t1" });
    expect(await text(await POST(call("metaWeblog.getRecentPosts", ["1", "u", "t", "5"])))).not.toMatch(/not allowed/);
    expect(await text(await POST(call("metaWeblog.getPost", ["p1", "u", "t"])))).not.toMatch(/not allowed/);
  });
});

describe("getPost no longer leaks unpublished work", () => {
  it("filters on published, like getRecentPosts already did", async () => {
    await POST(call("metaWeblog.getPost", ["p1", "u", "t"]));
    expect(prisma.post.findFirst).toHaveBeenCalledWith({
      where: { id: "p1", published: true },
    });
  });

  it("404s a draft rather than returning its body", async () => {
    vi.mocked(prisma.post.findFirst).mockResolvedValue(null as never);
    expect(await text(await POST(call("metaWeblog.getPost", ["draft", "u", "t"])))).toContain("Post not found");
  });
});

describe("deletePost reports honestly", () => {
  it("404s an unknown id instead of claiming success", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null as never);
    expect(await text(await POST(del("t", "nope")))).toContain("Post not found");
    expect(deletePostWithFederation).not.toHaveBeenCalled();
  });
});
