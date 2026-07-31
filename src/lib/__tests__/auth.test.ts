import { describe, it, expect, beforeEach , afterEach } from "vitest";
import crypto from "crypto";
import { safeCompare, hashToken, verifyAdminCookieValue, verifyOrigin, verifySameOriginRequest, sessionIdFromCookie } from "../auth";

// verifyAdminCookieValue and verifyOrigin don't touch the DB so they can be
// tested without mocking Prisma.

describe("safeCompare", () => {
  it("returns true for equal strings", () => {
    expect(safeCompare("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(safeCompare("hello", "world")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(safeCompare("short", "much longer string")).toBe(false);
  });

  it("returns false when either argument is empty", () => {
    expect(safeCompare("", "something")).toBe(false);
    expect(safeCompare("something", "")).toBe(false);
    expect(safeCompare("", "")).toBe(false);
  });
});

describe("hashToken", () => {
  it("returns a 64-char hex string", () => {
    expect(hashToken("mytoken")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});

describe("verifyAdminCookieValue", () => {
  const secret = "test-secret-1234";

  function makeCookie(sessionId?: string, overrideSecret?: string): string {
    const id = sessionId ?? crypto.randomBytes(16).toString("hex");
    const mac = crypto
      .createHmac("sha256", overrideSecret ?? secret)
      .update(id)
      .digest("hex");
    return `${id}.${mac}`;
  }

  beforeEach(() => {
    process.env.ADMIN_SECRET = secret;
  });

  it("accepts a well-formed valid cookie", () => {
    expect(verifyAdminCookieValue(makeCookie())).toBe(true);
  });

  it("rejects a cookie signed with wrong secret", () => {
    expect(verifyAdminCookieValue(makeCookie(undefined, "wrong-secret"))).toBe(false);
  });

  it("rejects a tampered session ID", () => {
    const cookie = makeCookie("aabbccddeeff00112233445566778899");
    // Flip one char of the session ID
    const tampered = "aabbccddeeff001122334455667788" + "00" + cookie.slice(32);
    expect(verifyAdminCookieValue(tampered)).toBe(false);
  });

  it("rejects a tampered MAC", () => {
    const cookie = makeCookie();
    const [id, mac] = cookie.split(".");
    const tamperedMac = mac.slice(0, -1) + (mac.endsWith("a") ? "b" : "a");
    expect(verifyAdminCookieValue(`${id}.${tamperedMac}`)).toBe(false);
  });

  it("rejects when ADMIN_SECRET is not set", () => {
    const cookie = makeCookie();
    delete process.env.ADMIN_SECRET;
    expect(verifyAdminCookieValue(cookie)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(verifyAdminCookieValue(undefined)).toBe(false);
  });

  it("rejects a cookie missing the dot separator", () => {
    expect(verifyAdminCookieValue("nodothere")).toBe(false);
  });

  it("rejects a session ID that fails the hex format check", () => {
    const mac = crypto.createHmac("sha256", secret).update("ZZZZ").digest("hex");
    expect(verifyAdminCookieValue(`ZZZZ.${mac}`)).toBe(false);
  });
});

describe("sessionIdFromCookie", () => {
  it("extracts the 32-hex session id from a well-formed cookie", () => {
    const id = "aabbccddeeff00112233445566778899";
    expect(sessionIdFromCookie(`${id}.deadbeef`)).toBe(id);
  });

  it("returns null for undefined, missing dot, or bad-length / non-hex id", () => {
    expect(sessionIdFromCookie(undefined)).toBeNull();
    expect(sessionIdFromCookie("nodothere")).toBeNull();
    expect(sessionIdFromCookie(".mac")).toBeNull();
    expect(sessionIdFromCookie("tooshort.mac")).toBeNull();
    expect(sessionIdFromCookie("ZZZZccddeeff00112233445566778899.mac")).toBeNull();
  });
});

describe("verifyOrigin", () => {
  beforeEach(() => {
    process.env.SITE_URL = "https://example.com";
  });

  const req = (origin: string | null, referer: string | null = null) => ({
    headers: {
      get: (name: string) => (name === "origin" ? origin : name === "referer" ? referer : null),
    },
  });

  it("accepts a matching origin", () => {
    expect(verifyOrigin(req("https://example.com"))).toBe(true);
  });

  it("accepts a matching referer when no origin header", () => {
    expect(verifyOrigin(req(null, "https://example.com/page"))).toBe(true);
  });

  it("rejects a different domain", () => {
    expect(verifyOrigin(req("https://evil.com"))).toBe(false);
  });

  it("rejects a different protocol", () => {
    expect(verifyOrigin(req("http://example.com"))).toBe(false);
  });

  it("rejects when both origin and referer are absent", () => {
    expect(verifyOrigin(req(null, null))).toBe(false);
  });

  it("rejects a same-host request on a different port", () => {
    process.env.SITE_URL = "https://example.com:8443";
    expect(verifyOrigin(req("https://example.com:8443"))).toBe(true);
    expect(verifyOrigin(req("https://example.com:9443"))).toBe(false);
    expect(verifyOrigin(req("https://example.com"))).toBe(false); // implicit :443 ≠ :8443
  });
});

/**
 * `verifySameOriginRequest` — the recovery check (#426, #430).
 *
 * `verifyOrigin` compares against the CONFIGURED origin, so a wrong `SITE_URL`
 * 403s every mutation including the one route that would set it back, and on a
 * fresh install (`getSiteUrl()` === localhost) it would 403 the setup wizard for
 * every Docker and proxy install. This compares against the request's OWN host
 * instead.
 *
 * It is deliberately WEAKER than `verifyOrigin`: it asks "is this same-origin?",
 * not "is this to the address I think I am". A hostname an attacker owns, pointed
 * at this server's IP, is same-origin to the browser and passes. That is only
 * affordable because all three call sites check a credential FIRST — an admin
 * cookie scoped to the real hostname, or an out-of-band setup token, neither of
 * which travels to the attacker's host.
 */
describe("verifySameOriginRequest", () => {
  const OLD_PROXY = process.env.TRUSTED_PROXY;
  afterEach(() => {
    if (OLD_PROXY === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = OLD_PROXY;
  });

  /** A header bag — the verifyOrigin factory can't express `host`. */
  const req = (h: Record<string, string>) => ({
    headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
  });

  it("#426: accepts the serving host even when SITE_URL points elsewhere", () => {
    // The whole recovery property. verifyOrigin returns false here.
    process.env.SITE_URL = "https://wrong.example";
    const r = req({ host: "real.example", origin: "https://real.example" });
    expect(verifySameOriginRequest(r)).toBe(true);
    expect(verifyOrigin(r)).toBe(false);
  });

  it("#430: accepts during setup, when SITE_URL isn't written yet", () => {
    delete process.env.SITE_URL; // getSiteUrl() -> http://localhost:3000
    expect(
      verifySameOriginRequest(req({ host: "real.example", origin: "https://real.example" })),
    ).toBe(true);
  });

  it("still rejects a genuine cross-site origin", () => {
    expect(
      verifySameOriginRequest(req({ host: "real.example", origin: "https://evil.example" })),
    ).toBe(false);
  });

  it("IGNORES x-forwarded-host unless TRUSTED_PROXY is set", () => {
    // The most important case here. Next normalises `x-forwarded-host ??= host`,
    // so a CLIENT-supplied XFH is passed straight through. Honouring it unguarded
    // would let a non-browser caller name any host it liked and match its own
    // Origin to it.
    delete process.env.TRUSTED_PROXY;
    expect(
      verifySameOriginRequest(
        req({ host: "real.example", "x-forwarded-host": "evil.example", origin: "https://evil.example" }),
      ),
    ).toBe(false);
  });

  it("honours x-forwarded-host when TRUSTED_PROXY is set", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(
      verifySameOriginRequest(
        req({ host: "backend:3000", "x-forwarded-host": "real.example", origin: "https://real.example" }),
      ),
    ).toBe(true);
  });

  it("accepts an origin with a port when the proxy stripped it from Host", () => {
    // nginx's `proxy_set_header Host $host` DROPS the port ($http_host keeps it).
    // A strict host comparison would 403 every non-default-port install behind the
    // config we ship — reintroducing the very lockout this fixes. Recorded as a
    // decision, not an accident.
    expect(
      verifySameOriginRequest(req({ host: "real.example", origin: "https://real.example:8443" })),
    ).toBe(true);
  });

  it("compares the port when Host still carries one", () => {
    expect(
      verifySameOriginRequest(req({ host: "real.example:8443", origin: "https://real.example:8443" })),
    ).toBe(true);
    expect(
      verifySameOriginRequest(req({ host: "real.example:8443", origin: "https://real.example:9443" })),
    ).toBe(false);
  });

  it("checks the scheme only when a trusted proxy reports one", () => {
    process.env.TRUSTED_PROXY = "true";
    const h = { host: "real.example", "x-forwarded-proto": "https" };
    expect(verifySameOriginRequest(req({ ...h, origin: "http://real.example" }))).toBe(false);
    expect(verifySameOriginRequest(req({ ...h, origin: "https://real.example" }))).toBe(true);

    // Without a trusted proxy there is no scheme to compare against, so an http
    // origin passes. Documented behaviour, not an oversight — the credential
    // check in front of every call site is what carries the weight.
    delete process.env.TRUSTED_PROXY;
    expect(
      verifySameOriginRequest(req({ host: "real.example", origin: "http://real.example" })),
    ).toBe(true);
  });

  it("falls back to Referer, which is no more forgeable than Origin", () => {
    // Both are forbidden header names. The difference is that a Referrer-Policy
    // can SUPPRESS Referer — a false 403, never a bypass — so accepting it costs
    // nothing and buys recovery when Origin is absent.
    expect(
      verifySameOriginRequest(req({ host: "real.example", referer: "https://real.example/admin/site" })),
    ).toBe(true);
    expect(
      verifySameOriginRequest(req({ host: "real.example", referer: "https://evil.example/x" })),
    ).toBe(false);
  });

  it("fails closed with no Origin and no Referer", () => {
    expect(verifySameOriginRequest(req({ host: "real.example" }))).toBe(false);
  });

  it("fails closed on a missing or malformed Host", () => {
    for (const host of [undefined, "", "real.example/evil", "real example", "real.example\\evil"]) {
      const h: Record<string, string> = { origin: "https://real.example" };
      if (host !== undefined) h.host = host;
      expect(verifySameOriginRequest(req(h)), `host=${JSON.stringify(host)}`).toBe(false);
    }
  });

  it("rejects opaque and non-http origins", () => {
    for (const origin of ["null", "", "data:text/html,x", "file:///x", "javascript:alert(1)"]) {
      expect(
        verifySameOriginRequest(req({ host: "real.example", origin })),
        origin,
      ).toBe(false);
    }
  });

  it("is case-insensitive on the host, and handles IPv6", () => {
    expect(
      verifySameOriginRequest(req({ host: "REAL.example", origin: "https://real.EXAMPLE" })),
    ).toBe(true);
    expect(
      verifySameOriginRequest(req({ host: "[::1]:3000", origin: "http://[::1]:3000" })),
    ).toBe(true);
  });
});

describe("verifyOrigin with a broken SITE_URL", () => {
  it("returns false instead of throwing a 500", () => {
    // `new URL(siteUrl)` sat outside the try/catch, so a scheme-less SITE_URL
    // turned every mutation into a 500 with a stack rather than a 403.
    process.env.SITE_URL = "example.com";
    const r = { headers: { get: (n: string) => (n === "origin" ? "https://example.com" : null) } };
    expect(() => verifyOrigin(r)).not.toThrow();
    expect(verifyOrigin(r)).toBe(false);
  });
});
