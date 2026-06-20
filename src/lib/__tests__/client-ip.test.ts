import { describe, it, expect, afterEach } from "vitest";
import { rateLimitKey } from "../client-ip";

function reqWith(headers: Record<string, string>) {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

describe("rateLimitKey", () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY;
  });

  it("returns 'default' when TRUSTED_PROXY is unset, ignoring forwarded headers", () => {
    // Without a trusted proxy, X-Forwarded-For / X-Real-IP are attacker-spoofable,
    // so every request must collapse to one bucket (H2/H3) — no rotating buckets.
    expect(
      rateLimitKey(reqWith({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" })),
    ).toBe("default");
  });

  it("uses the first X-Forwarded-For hop when TRUSTED_PROXY=true", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(
      rateLimitKey(reqWith({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" })),
    ).toBe("9.9.9.9");
  });

  it("falls back to X-Real-IP when TRUSTED_PROXY=true and X-Forwarded-For is absent", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(rateLimitKey(reqWith({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("returns 'default' when TRUSTED_PROXY=true but no forwarded headers are present", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(rateLimitKey(reqWith({}))).toBe("default");
  });

  it("returns 'default' for an empty X-Forwarded-For value (no usable hop)", () => {
    process.env.TRUSTED_PROXY = "true";
    expect(rateLimitKey(reqWith({ "x-forwarded-for": "   " }))).toBe("default");
  });
});
