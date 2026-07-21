import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin } = vi.hoisted(() => ({ verifyAdmin: vi.fn() }));
vi.mock("@/lib/auth", () => ({ verifyAdmin }));
const { verifySetupToken } = vi.hoisted(() => ({ verifySetupToken: vi.fn() }));
vi.mock("@/lib/setup-token", () => ({ verifySetupToken }));
const { saveUploadedImage } = vi.hoisted(() => ({ saveUploadedImage: vi.fn() }));
vi.mock("@/lib/media", () => ({ saveUploadedImage }));

import { POST } from "@/app/api/setup/media/route";

const OLD_ADMIN = process.env.ADMIN_SECRET;

function req(token: string | null, withFile = true): NextRequest {
  const fd = new FormData();
  if (withFile) fd.append("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
  return new Request("https://x/api/setup/media", {
    method: "POST",
    headers: token ? { "x-setup-token": token } : {},
    body: fd,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ADMIN_SECRET; // fresh deploy → token branch
  verifyAdmin.mockResolvedValue(true);
  verifySetupToken.mockResolvedValue(true);
  saveUploadedImage.mockResolvedValue({ ok: true, path: "/uploads/2026/07/x.webp" });
});
afterEach(() => {
  if (OLD_ADMIN === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = OLD_ADMIN;
});

describe("/api/setup/media (#59)", () => {
  it("fresh deploy: rejects a bad setup token without touching the file", async () => {
    verifySetupToken.mockResolvedValue(false);
    expect((await POST(req("wrong"))).status).toBe(401);
    expect(saveUploadedImage).not.toHaveBeenCalled();
  });

  it("fresh deploy: a valid token uploads and returns the relative path", async () => {
    const res = await POST(req("good-token"));
    expect(res.status).toBe(201);
    expect(verifySetupToken).toHaveBeenCalledWith("good-token");
    expect(await res.json()).toEqual({ path: "/uploads/2026/07/x.webp" });
  });

  it("once ADMIN_SECRET is set, it requires admin auth (not the token)", async () => {
    process.env.ADMIN_SECRET = "x".repeat(64);
    verifyAdmin.mockResolvedValue(false);
    expect((await POST(req("any"))).status).toBe(401);
    verifyAdmin.mockResolvedValue(true);
    expect((await POST(req("any"))).status).toBe(201);
  });

  it("400 when no file is provided", async () => {
    expect((await POST(req("good-token", false))).status).toBe(400);
    expect(saveUploadedImage).not.toHaveBeenCalled();
  });

  it("surfaces a save error (e.g. unsupported type) as 400", async () => {
    saveUploadedImage.mockResolvedValue({ ok: false, error: "unsupported file type" });
    expect((await POST(req("good-token"))).status).toBe(400);
  });
});
