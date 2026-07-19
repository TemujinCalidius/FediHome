import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin, verifyOrigin } = vi.hoisted(() => ({ verifyAdmin: vi.fn(), verifyOrigin: vi.fn() }));
vi.mock("@/lib/auth", () => ({ verifyAdmin, verifyOrigin }));
const { setKey, clearKey, status } = vi.hoisted(() => ({ setKey: vi.fn(), clearKey: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/analytics-secret", () => ({
  setTinylyticsApiKey: setKey, clearTinylyticsApiKey: clearKey, getAnalyticsKeyStatus: status,
}));
vi.mock("@/lib/secret-box", () => ({ secretBoxAvailable: () => true }));

import { GET, POST } from "@/app/api/admin/analytics-key/route";

const postReq = (body: unknown): NextRequest =>
  new Request("https://x/api/admin/analytics-key", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
const getReq = () => new Request("https://x/api/admin/analytics-key") as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  verifyAdmin.mockResolvedValue(true);
  verifyOrigin.mockReturnValue(true);
  status.mockResolvedValue({ configured: true, source: "db" });
  setKey.mockResolvedValue({ ok: true });
  clearKey.mockResolvedValue(undefined);
});

describe("/api/admin/analytics-key (#59)", () => {
  it("GET requires admin, returns status only (never the key)", async () => {
    verifyAdmin.mockResolvedValue(false);
    expect((await GET(getReq())).status).toBe(401);
    verifyAdmin.mockResolvedValue(true);
    const body = await (await GET(getReq())).json();
    expect(body).toEqual({ status: { configured: true, source: "db" }, encryptionAvailable: true });
    expect(JSON.stringify(body)).not.toMatch(/apikey|secret/i);
  });

  it("POST is CSRF-gated then admin-gated (cookie surface, no bearer)", async () => {
    verifyOrigin.mockReturnValue(false);
    expect((await POST(postReq({ apiKey: "k" }))).status).toBe(403);
    verifyOrigin.mockReturnValue(true);
    verifyAdmin.mockResolvedValue(false);
    expect((await POST(postReq({ apiKey: "k" }))).status).toBe(401);
    expect(setKey).not.toHaveBeenCalled();
  });

  it("POST saves a valid key (trimmed) and returns status without echoing the key", async () => {
    const res = await POST(postReq({ apiKey: "  tly_key_123  " }));
    expect(res.status).toBe(200);
    expect(setKey).toHaveBeenCalledWith("tly_key_123");
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(JSON.stringify(body)).not.toContain("tly_key_123");
  });

  it("POST rejects an empty or control-char key without storing", async () => {
    expect((await POST(postReq({ apiKey: "" }))).status).toBe(400);
    expect((await POST(postReq({ apiKey: "line1\nline2" }))).status).toBe(400);
    expect(setKey).not.toHaveBeenCalled();
  });

  it("POST { clear: true } removes the stored key (no set)", async () => {
    const res = await POST(postReq({ clear: true }));
    expect(res.status).toBe(200);
    expect(clearKey).toHaveBeenCalled();
    expect(setKey).not.toHaveBeenCalled();
  });

  it("surfaces a set error (e.g. no ADMIN_SECRET) as 400", async () => {
    setKey.mockResolvedValue({ ok: false, error: "Encryption unavailable — ADMIN_SECRET is not set." });
    expect((await POST(postReq({ apiKey: "k" }))).status).toBe(400);
  });
});
