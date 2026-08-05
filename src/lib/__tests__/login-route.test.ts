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
// SHARED_BUCKET_KEY too: login-throttle imports it to decide whether the key
// names one caller or is the everybody-shares-it fallback (#531).
vi.mock("@/lib/client-ip", () => ({ rateLimitKey, SHARED_BUCKET_KEY: "default" }));
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

/**
 * #531. On the default configuration `rateLimitKey` returns one string for
 * everybody, and the login route locked that key after five failures a minute —
 * so an unauthenticated caller could hold the owner out of their own panel
 * indefinitely, and the 429 came back before the password was even examined.
 *
 * Fresh module per test: the throttle's counters are module-level by design, and
 * the global tier is shared by construction, so they'd otherwise carry across
 * tests in a file that deliberately fails a lot of logins. Same idiom as
 * client-ip.test.ts.
 */
describe("#531 — a shared bucket must not lock the owner out", () => {
  async function fresh() {
    vi.resetModules();
    return {
      POST: (await import("@/app/api/admin/login/route")).POST,
      throttle: await import("@/lib/login-throttle"),
    };
  }

  it("does not apply the strict per-caller limit to the shared key", async () => {
    // The whole bug. 5/60s is protection when the key names a caller and a
    // lockout primitive when it names everybody at once.
    const { throttle } = await fresh();
    for (let i = 0; i < 8; i++) throttle.recordLoginFailure("default");
    expect(throttle.loginBlockedBy("default")).toBeNull();
  });

  it("still applies it to a key that does name one caller", async () => {
    const { throttle } = await fresh();
    for (let i = 0; i < 5; i++) throttle.recordLoginFailure("203.0.113.7");
    expect(throttle.loginBlockedBy("203.0.113.7")).toBe("per-caller");
  });

  it("keeps one caller's failures off another caller's budget", async () => {
    const { throttle } = await fresh();
    for (let i = 0; i < 5; i++) throttle.recordLoginFailure("203.0.113.7");
    expect(throttle.loginBlockedBy("198.51.100.4")).toBeNull();
  });

  it("falls back to a global wall so the shared case is not unlimited", async () => {
    const { throttle } = await fresh();
    for (let i = 0; i < 20; i++) throttle.recordLoginFailure("default");
    expect(throttle.loginBlockedBy("default")).toBe("global");
  });

  it("lets the global wall lapse on its own, so a lockout is not permanent", async () => {
    // The point of the short window: an owner with no per-caller key waits
    // minutes, not forever. That is the difference between annoyance and lockout.
    const { throttle } = await fresh();
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) throttle.recordLoginFailure("default", t0);
    expect(throttle.loginBlockedBy("default", t0)).toBe("global");
    expect(throttle.loginBlockedBy("default", t0 + 5 * 60_000 + 1)).toBeNull();
  });

  it("a caller cannot reach the reserved key by claiming to be it", async () => {
    // The same two-tier design on the private instance had a live hole here: a
    // caller who could influence the key sent the reserved key's own name as
    // their address, reached that row through the per-caller path, and a fresh
    // window there reset the count — clearing a lockout in progress.
    //
    // Two things stop it here, and it is worth being precise about which does
    // the work. The tiers are SEPARATE limiter instances with separate Maps, so
    // there is no shared row to collide on at all — that is the real defence,
    // and it is the thing the private instance lacked. The `ip:` prefix is the
    // belt: it keeps the property true if the two are ever merged into one
    // store, which is exactly the refactor that opened the hole there.
    const { throttle } = await fresh();
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) throttle.recordLoginFailure("default", t0);
    expect(throttle.loginBlockedBy("default", t0)).toBe("global");

    // Past the per-caller window, still inside the global one. A caller named
    // "global" starting a fresh per-caller window must not roll the real one over.
    const t1 = t0 + 61_000;
    throttle.recordLoginFailure("global", t1);
    expect(throttle.loginBlockedBy("default", t1)).toBe("global");
  });

  it("a correct password clears both tiers", async () => {
    const { throttle } = await fresh();
    for (let i = 0; i < 5; i++) throttle.recordLoginFailure("203.0.113.7");
    expect(throttle.loginBlockedBy("203.0.113.7")).toBe("per-caller");
    throttle.clearLoginAttempts("203.0.113.7");
    expect(throttle.loginBlockedBy("203.0.113.7")).toBeNull();
  });

  it("free requests reach neither counter", async () => {
    // A malformed body or a non-string password returns before verification, so
    // it must cost nothing — otherwise the lockout is available for the price of
    // an empty POST, which is the same attack with a smaller bill.
    const { POST, throttle } = await fresh();
    rateLimitKey.mockReturnValue("203.0.113.9");
    for (let i = 0; i < 10; i++) {
      await POST({ headers: new Headers(), json: async () => ({}) } as never);
      await POST({
        headers: new Headers(),
        json: async () => {
          throw new Error("not json");
        },
      } as never);
    }
    expect(throttle.loginBlockedBy("203.0.113.9")).toBeNull();
  });

  it("says once, in the log, that visitors cannot be told apart", async () => {
    // Lands in the support bundle's log tail (#490), and names the setting that
    // fixes it rather than leaving the owner to find #515.
    const { throttle } = await fresh();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    throttle.warnIfSharedBucket("default");
    throttle.warnIfSharedBucket("default");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("TRUSTED_PROXY_HEADER");
  });

  it("says nothing when the key does name a caller", async () => {
    const { throttle } = await fresh();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    throttle.warnIfSharedBucket("203.0.113.7");
    expect(warn).not.toHaveBeenCalled();
  });
});
