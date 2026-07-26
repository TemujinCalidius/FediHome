import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { NextRequest } from "next/server";

/**
 * The admin login route.
 *
 * It had NO test coverage at all before #356 — not the rate limiter, not the
 * 401 shape, not the cookie flags — despite being the front door.
 *
 * The behaviour that matters most here is the migration path: an existing
 * install has no stored password, and must keep logging in with ADMIN_SECRET
 * exactly as before, with no operator action. Once a real password is set, the
 * secret stops being a password at all.
 */

const { createAdminSession, getPasswordHash, verifyPassword } = vi.hoisted(() => ({
  createAdminSession: vi.fn(),
  getPasswordHash: vi.fn(),
  verifyPassword: vi.fn(),
}));
vi.mock("@/lib/auth", async () => {
  const crypto = await import("crypto");
  return {
    createAdminSession,
    // The real constant-time compare — this is the fallback under test.
    safeCompare: (a: string, b: string) => {
      const ab = Buffer.from(a ?? "", "utf8");
      const bb = Buffer.from(b ?? "", "utf8");
      return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
    },
  };
});
vi.mock("@/lib/password", () => ({ getPasswordHash, verifyPassword }));
// The limiter keeps module-level buckets keyed by client. Give every test its
// own key, or one test's failed attempts exhaust the next test's budget.
const { rateLimitKey } = vi.hoisted(() => ({ rateLimitKey: vi.fn() }));
vi.mock("@/lib/client-ip", () => ({ rateLimitKey }));
let keySeq = 0;

import { POST } from "@/app/api/admin/login/route";

const SECRET = "s".repeat(64);
const OLD_SECRET = process.env.ADMIN_SECRET;

const req = (body: unknown, ua = "vitest"): NextRequest =>
  new Request("https://demo.example/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": ua },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitKey.mockReturnValue(`test-key-${++keySeq}`);
  process.env.ADMIN_SECRET = SECRET;
  getPasswordHash.mockResolvedValue(null);
  createAdminSession.mockResolvedValue({ cookieValue: "sid.mac", maxAgeSeconds: 3600 });
});

afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = OLD_SECRET;
});

describe("migration path — no stored password yet", () => {
  it("accepts ADMIN_SECRET, exactly as before the split", async () => {
    const res = await POST(req({ password: SECRET }));
    expect(res.status).toBe(200);
    expect(createAdminSession).toHaveBeenCalled();
  });

  it("tells the client a real password still needs setting", async () => {
    const body = await (await POST(req({ password: SECRET }))).json();
    expect(body).toMatchObject({ success: true, needsPassword: true });
  });

  it("rejects a wrong secret", async () => {
    const res = await POST(req({ password: "wrong" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect(createAdminSession).not.toHaveBeenCalled();
  });
});

describe("once a password is set, ADMIN_SECRET is no longer a password", () => {
  beforeEach(() => {
    getPasswordHash.mockResolvedValue("scrypt$16384$8$1$c2FsdA==$aGFzaA==");
  });

  it("accepts the stored password", async () => {
    verifyPassword.mockResolvedValue(true);
    const res = await POST(req({ password: "my chosen password" }));
    expect(res.status).toBe(200);
    expect(verifyPassword).toHaveBeenCalledWith("my chosen password", expect.any(String));
  });

  it("REFUSES ADMIN_SECRET once a password exists", async () => {
    // The whole point of the split — the secret goes back to being key material
    // and stops being a credential anyone types.
    verifyPassword.mockResolvedValue(false);
    const res = await POST(req({ password: SECRET }));
    expect(res.status).toBe(401);
  });

  it("reports that no further password setup is needed", async () => {
    verifyPassword.mockResolvedValue(true);
    const body = await (await POST(req({ password: "my chosen password" }))).json();
    expect(body.needsPassword).toBe(false);
  });
});

describe("the session cookie", () => {
  it("is httpOnly, lax, and path-scoped", async () => {
    const res = await POST(req({ password: SECRET }));
    const cookie = res.cookies.get("sl_admin");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
    expect(cookie?.maxAge).toBe(3600);
  });
});

describe("input handling", () => {
  it("400s on a non-JSON body instead of throwing a 500", async () => {
    expect((await POST(req("not json at all"))).status).toBe(400);
  });

  it("401s when password isn't a string", async () => {
    expect((await POST(req({ password: { $ne: null } }))).status).toBe(401);
    expect((await POST(req({}))).status).toBe(401);
  });

  it("refuses everything when ADMIN_SECRET is unset and no password exists", async () => {
    // Otherwise an empty secret would make an empty password valid.
    delete process.env.ADMIN_SECRET;
    expect((await POST(req({ password: "" }))).status).toBe(401);
  });
});

describe("rate limiting", () => {
  it("429s after repeated failures, and stops checking credentials", async () => {
    for (let i = 0; i < 5; i++) await POST(req({ password: "wrong" }));
    const res = await POST(req({ password: "wrong" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/too many/i);
  });

  it("a correct login clears the counter", async () => {
    for (let i = 0; i < 3; i++) await POST(req({ password: "wrong" }));
    expect((await POST(req({ password: SECRET }))).status).toBe(200);
    // Counter reset, so a fresh wrong attempt is a 401 rather than a 429.
    expect((await POST(req({ password: "wrong" }))).status).toBe(401);
  });
});
