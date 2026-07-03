import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verify, del } = vi.hoisted(() => ({ verify: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  verifyMicropubToken: verify,
  // the route now imports hasScope from auth too — keep the real (pure) impl
  hasScope: (scope: string | undefined, required: string) => (scope ?? "").split(/\s+/).includes(required),
}));
vi.mock("@/lib/delete-post", () => ({ deletePostWithFederation: del }));
vi.mock("@/lib/audit", () => ({ recordTokenUse: vi.fn() }));
vi.mock("@/lib/publish-post", () => ({ publishPost: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { post: { findUnique: vi.fn() } } }));

import { POST } from "@/app/api/micropub/route";
import { prisma } from "@/lib/db";

function jsonReq(body: unknown): NextRequest {
  return new Request("https://x/api/micropub", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function formReq(fields: Record<string, string>): NextRequest {
  const body = new URLSearchParams(fields).toString();
  return new Request("https://x/api/micropub", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer t" },
    body,
  }) as unknown as NextRequest;
}

const DEL = { action: "delete", url: "https://x/post/hello" };

beforeEach(() => vi.clearAllMocks());

describe("Micropub delete (#16)", () => {
  it("401 when the token is invalid", async () => {
    verify.mockResolvedValue({ valid: false });
    const res = await POST(jsonReq(DEL));
    expect(res.status).toBe(401);
    expect(del).not.toHaveBeenCalled();
  });

  it("403 when the token lacks the `delete` scope", async () => {
    verify.mockResolvedValue({ valid: true, scope: "create update media" });
    const res = await POST(jsonReq(DEL));
    expect(res.status).toBe(403);
    expect(del).not.toHaveBeenCalled();
  });

  it("404 when the post isn't found", async () => {
    verify.mockResolvedValue({ valid: true, scope: "create update delete media" });
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null as never);
    const res = await POST(jsonReq(DEL));
    expect(res.status).toBe(404);
    expect(del).not.toHaveBeenCalled();
  });

  it("204 + calls the federated-delete helper when scoped and found (JSON)", async () => {
    verify.mockResolvedValue({ valid: true, scope: "create update delete media" });
    vi.mocked(prisma.post.findUnique).mockResolvedValue(
      { id: "p1", slug: "hello", apId: "https://x/post/hello", published: true } as never,
    );
    const res = await POST(jsonReq(DEL));
    expect(res.status).toBe(204);
    expect(prisma.post.findUnique).toHaveBeenCalledWith({ where: { slug: "hello" } });
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("204 via the FORM-ENCODED delete path (the headline behaviour)", async () => {
    verify.mockResolvedValue({ valid: true, scope: "create update delete media" });
    vi.mocked(prisma.post.findUnique).mockResolvedValue(
      { id: "p1", slug: "hello", apId: "https://x/post/hello", published: true } as never,
    );
    const res = await POST(formReq({ action: "delete", url: "https://x/post/hello/" }));
    expect(res.status).toBe(204);
    expect(prisma.post.findUnique).toHaveBeenCalledWith({ where: { slug: "hello" } }); // trailing slash handled
    expect(del).toHaveBeenCalledTimes(1);
  });
});
