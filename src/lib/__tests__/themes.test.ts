import { describe, it, expect } from "vitest";
import { deriveAccentScale, resolveTheme, isThemeId, buildThemeStyle, DEFAULT_THEME } from "@/lib/themes";

const sum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
};

describe("deriveAccentScale (#250)", () => {
  it("derives the 10-step accent scale with 500 = the base", () => {
    const scale = deriveAccentScale("#3b82f6");
    expect(Object.keys(scale)).toHaveLength(10);
    expect(scale["accent-500"]).toBe("#3b82f6");
  });

  it("is monotonic: lighter shades toward white, darker toward black", () => {
    const s = deriveAccentScale("#22c55e");
    expect(sum(s["accent-50"])).toBeGreaterThan(sum(s["accent-400"]));
    expect(sum(s["accent-400"])).toBeGreaterThan(sum(s["accent-500"]));
    expect(sum(s["accent-500"])).toBeGreaterThan(sum(s["accent-600"]));
    expect(sum(s["accent-600"])).toBeGreaterThan(sum(s["accent-900"]));
    expect(sum(s["accent-50"])).toBeGreaterThan(700); // near-white
  });

  it("returns {} for an invalid base", () => {
    expect(deriveAccentScale("red")).toEqual({});
    expect(deriveAccentScale("#fff")).toEqual({});
    expect(deriveAccentScale("")).toEqual({});
  });
});

describe("resolveTheme / isThemeId (#250)", () => {
  it("resolves a known id and falls back to default for an unknown one", () => {
    expect(resolveTheme("default")).toBe(DEFAULT_THEME);
    expect(resolveTheme("nope")).toBe(DEFAULT_THEME);
  });
  it("isThemeId only accepts registered ids", () => {
    expect(isThemeId("default")).toBe(true);
    expect(isThemeId("nope")).toBe(false);
    expect(isThemeId("")).toBe(false);
  });
});

describe("buildThemeStyle (#250)", () => {
  it("injects NOTHING for a default instance with the default accent", () => {
    expect(buildThemeStyle("default", null)).toBe("");
    expect(buildThemeStyle("default", undefined)).toBe("");
    expect(buildThemeStyle("default", "#3b82f6")).toBe("");
    expect(buildThemeStyle("default", "#3B82F6")).toBe(""); // case-insensitive
    expect(buildThemeStyle("unknown-id", null)).toBe(""); // resolves to default
  });

  it("emits a :root:root override scale for a custom accent colour", () => {
    const css = buildThemeStyle("default", "#22c55e");
    expect(css.startsWith(":root:root{")).toBe(true);
    expect(css).toContain("--color-accent-500:#22c55e");
    expect(css).toContain("--color-accent-400:"); // the derived lighter shade too
    // Only accent vars change — surfaces/fonts stay default (not emitted).
    expect(css).not.toContain("--color-surface-950");
    expect(css).not.toContain("--font-display");
  });
});
