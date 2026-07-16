import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin, verifyOrigin, generateToken } = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  verifyOrigin: vi.fn(),
  generateToken: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ verifyAdmin, verifyOrigin, generateToken }));
vi.mock("@/lib/db", () => ({ prisma: { authToken: { deleteMany: vi.fn(), updateMany: vi.fn() } } }));

import { POST } from "@/app/api/admin/apps/route";

const req = (body: unknown): NextRequest =>
  new Request("https://x/api/admin/apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  verifyOrigin.mockReturnValue(true);
  verifyAdmin.mockResolvedValue(true);
  generateToken.mockResolvedValue("rawtoken-abc123");
});

describe("POST /api/admin/apps — create token (#255)", () => {
  it("is CSRF- then admin-gated", async () => {
    verifyOrigin.mockReturnValue(false);
    expect((await POST(req({ action: "create", scope: "read" }))).status).toBe(403);
    verifyOrigin.mockReturnValue(true);
    verifyAdmin.mockResolvedValue(false);
    expect((await POST(req({ action: "create", scope: "read" }))).status).toBe(401);
  });

  it("mints a token and returns the RAW token once, with a sanitized scope + manual source", async () => {
    const res = await POST(req({ action: "create", label: "CI reader", scope: "read media junk" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, token: "rawtoken-abc123", label: "CI reader", scope: "read media" });
    expect(generateToken).toHaveBeenCalledWith(
      "CI reader",
      expect.objectContaining({ scope: "read media", createdVia: "manual" }),
    );
  });

  it("rejects an empty/unknown scope and mints nothing", async () => {
    const res = await POST(req({ action: "create", label: "x", scope: "notascope" }));
    expect(res.status).toBe(400);
    expect(generateToken).not.toHaveBeenCalled();
  });

  it("rejects an oversized label and mints nothing", async () => {
    const res = await POST(req({ action: "create", label: "x".repeat(101), scope: "read" }));
    expect(res.status).toBe(400);
    expect(generateToken).not.toHaveBeenCalled();
  });

  it("defaults the label when none is given", async () => {
    const data = await (await POST(req({ action: "create", scope: "read" }))).json();
    expect(data.label).toBe("Generated token");
    expect(generateToken).toHaveBeenCalledWith("Generated token", expect.anything());
  });
});
