import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin, verifyOrigin } = vi.hoisted(() => ({ verifyAdmin: vi.fn(), verifyOrigin: vi.fn() }));
vi.mock("@/lib/auth", () => ({ verifyAdmin, verifyOrigin }));
vi.mock("@/lib/secret-box", () => ({ secretBoxAvailable: () => true }));
const { status, generate, save, clear } = vi.hoisted(() => ({
  status: vi.fn(), generate: vi.fn(), save: vi.fn(), clear: vi.fn(),
}));
vi.mock("@/lib/push-config", () => ({
  getPushKeyStatus: status, generateVapidKeys: generate, setVapidKeys: save, clearVapidKeys: clear,
}));

import { GET, POST } from "@/app/api/admin/push-keys/route";

const post = (body: unknown): NextRequest =>
  new Request("https://x/api/admin/push-keys", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
const get = () => new Request("https://x/api/admin/push-keys") as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  verifyAdmin.mockResolvedValue(true);
  verifyOrigin.mockReturnValue(true);
  status.mockResolvedValue({ configured: true, source: "db", subject: "mailto:a@b" });
  generate.mockResolvedValue({ ok: true, publicKey: "PUB" });
  save.mockResolvedValue({ ok: true });
  clear.mockResolvedValue(undefined);
});

describe("/api/admin/push-keys (#59)", () => {
  it("GET requires admin, returns status only (never the private key)", async () => {
    verifyAdmin.mockResolvedValue(false);
    expect((await GET(get())).status).toBe(401);
    verifyAdmin.mockResolvedValue(true);
    const body = await (await GET(get())).json();
    expect(body.status).toEqual({ configured: true, source: "db", subject: "mailto:a@b" });
    expect(JSON.stringify(body)).not.toMatch(/private/i);
  });

  it("POST is CSRF-gated then admin-gated", async () => {
    verifyOrigin.mockReturnValue(false);
    expect((await POST(post({ action: "generate" }))).status).toBe(403);
    verifyOrigin.mockReturnValue(true);
    verifyAdmin.mockResolvedValue(false);
    expect((await POST(post({ action: "generate" }))).status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  it("generate mints keys and returns status", async () => {
    const res = await POST(post({ action: "generate" }));
    expect(res.status).toBe(200);
    expect(generate).toHaveBeenCalled();
    expect((await res.json()).success).toBe(true);
  });

  it("save requires both keys, then stores them", async () => {
    expect((await POST(post({ action: "save", publicKey: "P" }))).status).toBe(400); // missing private
    expect(save).not.toHaveBeenCalled();
    const res = await POST(post({ action: "save", publicKey: "P", privateKey: "Q" }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledWith("P", "Q", undefined);
  });

  it("clear removes the keys", async () => {
    expect((await POST(post({ action: "clear" }))).status).toBe(200);
    expect(clear).toHaveBeenCalled();
  });

  it("rejects an unknown action", async () => {
    expect((await POST(post({ action: "nope" }))).status).toBe(400);
  });

  it("surfaces a generate error (e.g. no ADMIN_SECRET) as 400", async () => {
    generate.mockResolvedValue({ ok: false, error: "Encryption unavailable — ADMIN_SECRET is not set." });
    expect((await POST(post({ action: "generate" }))).status).toBe(400);
  });
});
