import { describe, it, expect } from "vitest";
import { appTokenExpiry, isValidTtlDays, MAX_APP_TOKEN_TTL_DAYS } from "@/lib/oauth";

/**
 * #327. The issue's headline is wrong in a way worth stating: the global
 * `security.appTokenTtlDays` did NOT apply to admin-generated tokens. The
 * arithmetic was private to the OAuth route, and the Apps screen passed no
 * expiry at all — so every manually-generated token was permanent, while the
 * settings screen advertised a lifetime that half the tokens ignored.
 */
describe("appTokenExpiry", () => {
  const NOW = Date.UTC(2026, 0, 1);

  it("computes the expiry from the day count", () => {
    expect(appTokenExpiry(7, NOW)?.toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(appTokenExpiry(365, NOW)?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("treats 0 as never — which is what every existing token already is", () => {
    expect(appTokenExpiry(0, NOW)).toBeNull();
  });

  it("treats a negative or non-finite count as never rather than throwing", () => {
    // Reached from a stored setting, so it must not be able to mint a token
    // that expired in the past.
    for (const v of [-1, NaN, Infinity]) expect(appTokenExpiry(v, NOW)).toBeNull();
  });
});

describe("isValidTtlDays — what a client may ask for", () => {
  it("accepts the presets", () => {
    for (const v of [0, 7, 30, 90, 365]) expect(isValidTtlDays(v), String(v)).toBe(true);
  });

  it("accepts the cap and rejects one past it", () => {
    // Mirrors the int cap the settings screen already applies, so a per-token
    // pick can't outlive what that screen permits.
    expect(isValidTtlDays(MAX_APP_TOKEN_TTL_DAYS)).toBe(true);
    expect(isValidTtlDays(MAX_APP_TOKEN_TTL_DAYS + 1)).toBe(false);
  });

  it("rejects a numeric string, which is what a hand-rolled client sends", () => {
    expect(isValidTtlDays("7")).toBe(false);
  });

  it("rejects fractions and negatives", () => {
    for (const v of [7.5, -1, -0.5]) expect(isValidTtlDays(v), String(v)).toBe(false);
  });

  it("rejects null and undefined", () => {
    // null is NOT a way to say "never" — 0 already says that, and two spellings
    // of one thing is how they drift apart. Absent means "use the instance
    // default", which the route handles before this is consulted.
    expect(isValidTtlDays(null)).toBe(false);
    expect(isValidTtlDays(undefined)).toBe(false);
  });

  it("rejects NaN, which is what Number('') produces", () => {
    expect(isValidTtlDays(NaN)).toBe(false);
  });
});
