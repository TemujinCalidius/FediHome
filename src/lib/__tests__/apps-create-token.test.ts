import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin, verifyOrigin, generateToken } = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  verifyOrigin: vi.fn(),
  generateToken: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ verifyAdmin, verifyOrigin, generateToken }));
vi.mock("@/lib/db", () => ({ prisma: { authToken: { deleteMany: vi.fn(), updateMany: vi.fn() } } }));

// #327: the create branch reads the instance default when no ttlDays is sent.
const { getRuntimeSiteConfig } = vi.hoisted(() => ({ getRuntimeSiteConfig: vi.fn() }));
vi.mock("@/lib/site-settings", () => ({ getRuntimeSiteConfig }));

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
  // 0 is the shipped default (site.config.ts) — tokens never expire unless the
  // operator has deliberately set a lifetime.
  getRuntimeSiteConfig.mockResolvedValue({ security: { appTokenTtlDays: 0 } });
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

describe("create token — per-token expiry (#327)", () => {
  const create = (extra: Record<string, unknown> = {}) =>
    POST(req({ action: "create", label: "CI", scope: "read", ...extra }));
  const opts = () => generateToken.mock.calls[0][1];

  it("uses the instance default when ttlDays is absent", async () => {
    // The correction that matters: this branch passed NO expiry before, so the
    // global the settings screen advertises never reached a manually-generated
    // token. Absent now means "the instance setting", not "never".
    getRuntimeSiteConfig.mockResolvedValue({ security: { appTokenTtlDays: 30 } });
    await create();
    const at = opts().expiresAt as Date;
    expect(at).toBeInstanceOf(Date);
    expect(Math.round((at.getTime() - Date.now()) / 86_400_000)).toBe(30);
  });

  it("changes nothing for an instance that never set the global", async () => {
    // It ships as 0, so the default path stays exactly as it was today.
    await create();
    expect(opts().expiresAt).toBeNull();
  });

  it("an explicit choice beats the instance default", async () => {
    getRuntimeSiteConfig.mockResolvedValue({ security: { appTokenTtlDays: 365 } });
    await create({ ttlDays: 7 });
    const at = opts().expiresAt as Date;
    expect(Math.round((at.getTime() - Date.now()) / 86_400_000)).toBe(7);
  });

  it("an explicit 0 means never, even when the instance sets a lifetime", async () => {
    // Otherwise "Never" in the picker would be unreachable on any instance with
    // a global set — the one combination an operator is most likely to want.
    getRuntimeSiteConfig.mockResolvedValue({ security: { appTokenTtlDays: 30 } });
    await create({ ttlDays: 0 });
    expect(opts().expiresAt).toBeNull();
  });

  it("400s an invalid ttlDays without minting anything", async () => {
    for (const bad of ["7", -1, 7.5, 3651, null, {}]) {
      generateToken.mockClear();
      const res = await create({ ttlDays: bad });
      expect(res.status, `ttlDays=${JSON.stringify(bad)}`).toBe(400);
      expect(generateToken, `ttlDays=${JSON.stringify(bad)}`).not.toHaveBeenCalled();
    }
  });

  it("reports the expiry in the one-time reveal", async () => {
    // The only moment the operator sees the token is the only moment worth
    // telling them when it dies.
    await create({ ttlDays: 7 });
    const body = await (await create({ ttlDays: 7 })).json();
    expect(typeof body.expiresAt).toBe("string");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("reports null in the reveal for a token that never expires", async () => {
    const body = await (await create({ ttlDays: 0 })).json();
    expect(body.expiresAt).toBeNull();
  });
});
