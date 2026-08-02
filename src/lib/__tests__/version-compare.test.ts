import { describe, it, expect } from "vitest";
import { isNewer, isUpgrade, isMajorUpgrade } from "@/lib/version-compare";

/**
 * #465. checkOutdated() decided a package was outdated on INEQUALITY alone, so a
 * `latest` older than what's installed raised an alert telling the operator to
 * downgrade — labelled "(major)", because that was string inequality on the
 * first segment. Indistinguishable from a real alert, including in the bell.
 */
describe("isUpgrade — the guard the package loop was missing", () => {
  it("accepts a genuine upgrade", () => {
    expect(isUpgrade("8.20.2", "8.20.3")).toBe(true);
    expect(isUpgrade("0.20.36", "0.21.0")).toBe(true);
    expect(isUpgrade("6.0.3", "7.0.2")).toBe(true);
  });

  it("REFUSES a downgrade — the actual bug", () => {
    // Both observed in a real container run of check-updates.ts.
    expect(isUpgrade("2.3.4", "1.5.9")).toBe(false);
    expect(isUpgrade("0.20.36", "0.19.19")).toBe(false);
  });

  it("refuses a no-op", () => {
    expect(isUpgrade("1.2.3", "1.2.3")).toBe(false);
  });

  it("refuses when either side is missing", () => {
    // npm outdated can omit `latest` for a git or file dependency.
    expect(isUpgrade("1.2.3", "")).toBe(false);
    expect(isUpgrade("", "1.2.3")).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    // "10" < "9" as strings. A string compare would call this a downgrade.
    expect(isUpgrade("1.9.0", "1.10.0")).toBe(true);
    expect(isUpgrade("1.10.0", "1.9.0")).toBe(false);
  });

  it("treats a prerelease suffix as its base version rather than throwing", () => {
    // parseInt stops at the dash. Coarse, and deliberately so — the checker only
    // ever compares release tags, and NaN handling matters more than precision.
    expect(isUpgrade("2.3.4", "2.4.0-dev.1740")).toBe(true);
  });
});

describe("isMajorUpgrade — cannot disagree with the guard", () => {
  it("labels a real major bump", () => {
    expect(isMajorUpgrade("6.0.3", "7.0.2")).toBe(true);
  });

  it("does not label a minor bump", () => {
    expect(isMajorUpgrade("8.20.2", "8.20.3")).toBe(false);
  });

  it("never labels a downgrade as major, which is what it used to do", () => {
    // The old expression was `current.split(".")[0] !== latest.split(".")[0]`,
    // so 2.3.4 -> 1.5.9 came out as "(major)" — the most alarming possible
    // presentation of the most wrong possible advice.
    expect(isMajorUpgrade("2.3.4", "1.5.9")).toBe(false);
  });
});

describe("isNewer — kept as the primitive", () => {
  it("is strict, not >=", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
    expect(isNewer("1.2.4", "1.2.3")).toBe(true);
  });

  it("pads a short version rather than reading undefined", () => {
    expect(isNewer("1.3", "1.2.9")).toBe(true);
    expect(isNewer("1.2", "1.2.0")).toBe(false);
  });
});
