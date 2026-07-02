import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { authenticateApiRequest, verifyOrigin } = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  verifyOrigin: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest, verifyOrigin }));

import { POST } from "@/app/api/media/route";

const no = { ok: false, via: null, scope: "" };
const badScope = { ok: false, via: "bearer", scope: "read" };
const cookie = { ok: true, via: "cookie", scope: "*" };

const req = {} as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  verifyOrigin.mockReturnValue(true);
});

describe("POST /api/media — media scope + cookie CSRF", () => {
  it("requires the `media` scope", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    await POST(req);
    expect(authenticateApiRequest).toHaveBeenCalledWith(req, "media");
  });

  it("401 with no auth", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await POST(req)).status).toBe(401);
  });

  it("403 insufficient_scope for a bearer lacking `media`", async () => {
    authenticateApiRequest.mockResolvedValue(badScope);
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("insufficient_scope");
  });

  it("cookie path without a valid origin is 403 (CSRF)", async () => {
    authenticateApiRequest.mockResolvedValue(cookie);
    verifyOrigin.mockReturnValue(false);
    expect((await POST(req)).status).toBe(403);
  });
});
