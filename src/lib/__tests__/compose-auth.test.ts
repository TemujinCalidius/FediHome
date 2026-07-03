import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { authenticateApiRequest, verifyOrigin } = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  verifyOrigin: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest, verifyOrigin }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { POST } from "@/app/api/compose/route";

// Reject paths return at the auth preamble, before any body parse / DB / delivery,
// so we only need the auth mocks. (The success dispatch is the same widen pattern
// covered for /api/admin + /api/fedi-post-counts.)
const req = {} as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  verifyOrigin.mockReturnValue(true);
});

describe("POST /api/compose — bearer widen (#175)", () => {
  it("requires the `create` scope", async () => {
    authenticateApiRequest.mockResolvedValue({ ok: false, via: null, scope: "" });
    await POST(req);
    expect(authenticateApiRequest).toHaveBeenCalledWith(req, "create");
  });

  it("401 with no auth", async () => {
    authenticateApiRequest.mockResolvedValue({ ok: false, via: null, scope: "" });
    expect((await POST(req)).status).toBe(401);
  });

  it("403 insufficient_scope for a bearer lacking create", async () => {
    authenticateApiRequest.mockResolvedValue({ ok: false, via: "bearer", scope: "read" });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("insufficient_scope");
  });

  it("403 for the cookie path without a valid origin (CSRF)", async () => {
    authenticateApiRequest.mockResolvedValue({ ok: true, via: "cookie", scope: "*" });
    verifyOrigin.mockReturnValue(false);
    expect((await POST(req)).status).toBe(403);
    expect(verifyOrigin).toHaveBeenCalled();
  });
});
