import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  verifyMicropubToken: verify,
  hasScope: (s: string | undefined, r: string) => (s ?? "").split(/\s+/).includes(r),
}));
vi.mock("@/lib/audit", () => ({ recordTokenUse: vi.fn() }));
vi.mock("@/lib/publish-post", () => ({ publishPost: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { post: { create: vi.fn() } } }));

import { POST } from "@/app/api/micropub/route";
import { prisma } from "@/lib/db";

function jsonReq(body: unknown): NextRequest {
  return new Request("https://x/api/micropub", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  verify.mockResolvedValue({ valid: true, scope: "create update delete media" });
  // Draft → skips the federation/crosspost branch, keeping the test hermetic.
  vi.mocked(prisma.post.create).mockResolvedValue({ id: "p1", slug: "hello", published: false } as never);
});

describe("Micropub create — summary → excerpt (#181)", () => {
  it("stores the `summary` property as Post.excerpt", async () => {
    const res = await POST(
      jsonReq({
        type: ["h-entry"],
        properties: {
          name: ["Hello"],
          content: ["body"],
          summary: ["A short description"],
          "post-status": ["draft"],
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ excerpt: "A short description" }),
      }),
    );
  });

  it("excerpt is null when no summary is supplied", async () => {
    await POST(
      jsonReq({ type: ["h-entry"], properties: { content: ["just a note"], "post-status": ["draft"] } }),
    );
    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ excerpt: null }) }),
    );
  });
});
