import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import { safeCompare, hashToken, verifyAdminCookieValue, verifyOrigin, sessionIdFromCookie } from "../auth";

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
});
