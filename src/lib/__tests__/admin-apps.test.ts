import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin, verifyOrigin } = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  verifyOrigin: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ verifyAdmin, verifyOrigin }));
vi.mock("@/lib/db", () => ({ prisma: { authToken: { deleteMany: vi.fn() } } }));

import { POST } from "@/app/api/admin/apps/route";
import { prisma } from "@/lib/db";

function req(body: unknown): NextRequest {
  return new Request("https://x/api/admin/apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.authToken.deleteMany).mockResolvedValue({ count: 1 } as never);
  verifyOrigin.mockReturnValue(true);
  verifyAdmin.mockResolvedValue(true);
});

describe("POST /api/admin/apps", () => {
  it("403 on a bad origin (CSRF) before any auth or DB work", async () => {
    verifyOrigin.mockReturnValue(false);
    const res = await POST(req({ action: "revoke-all" }));
    expect(res.status).toBe(403);
    expect(prisma.authToken.deleteMany).not.toHaveBeenCalled();
  });

  it("401 when not an admin", async () => {
    verifyAdmin.mockResolvedValue(false);
    const res = await POST(req({ action: "revoke-all" }));
    expect(res.status).toBe(401);
    expect(prisma.authToken.deleteMany).not.toHaveBeenCalled();
  });

  it("revokes one token by id", async () => {
    const res = await POST(req({ action: "revoke", id: "clx123abc" }));
    expect(res.status).toBe(200);
    expect(prisma.authToken.deleteMany).toHaveBeenCalledWith({ where: { id: "clx123abc" } });
  });

  it("400 on a missing/oversized id", async () => {
    const res = await POST(req({ action: "revoke", id: "" }));
    expect(res.status).toBe(400);
    expect(prisma.authToken.deleteMany).not.toHaveBeenCalled();
  });

  it("revokes all tokens", async () => {
    vi.mocked(prisma.authToken.deleteMany).mockResolvedValue({ count: 3 } as never);
    const res = await POST(req({ action: "revoke-all" }));
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(3);
    expect(prisma.authToken.deleteMany).toHaveBeenCalledWith({});
  });

  it("400 on an unknown action", async () => {
    const res = await POST(req({ action: "nope" }));
    expect(res.status).toBe(400);
  });
});
