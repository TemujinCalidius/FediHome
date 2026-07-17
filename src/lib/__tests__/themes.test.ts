import { describe, it, expect } from "vitest";
import {
  deriveAccentScale, resolveTheme, isThemeId, buildThemeStyle, DEFAULT_THEME,
  isFeedVariant, resolveLayout, FEED_VARIANTS, THEMES,
} from "@/lib/themes";

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

describe("Editorial theme (#250)", () => {
  it("is registered and resolvable", () => {
    expect(isThemeId("editorial")).toBe(true);
    expect(resolveTheme("editorial").name).toBe("Editorial");
  });

  it("emits a full token override — but only what actually differs", () => {
    const css = buildThemeStyle("editorial", null);
    expect(css.startsWith(":root:root{")).toBe(true);
    // All 18 colour tokens differ from the default, so all 18 are emitted.
    for (const token of Object.keys(DEFAULT_THEME.tokens.colors)) {
      expect(css).toContain(`--color-${token}:`);
    }
    expect(css).toContain("--color-surface-950:#17120e");
    expect(css).toContain("--color-accent-500:#c2663d");
    // Fonts: display + body swap round; mono is identical → must be diffed out.
    expect(css).toContain("--font-display:");
    expect(css).toContain("--font-body:");
    expect(css).not.toContain("--font-mono");
  });

  it("defaults to the list feed, and an explicit override still wins", () => {
    expect(resolveLayout("editorial", {}).feed).toBe("list");
    expect(resolveLayout("editorial", { feed: "cards" }).feed).toBe("cards");
    expect(resolveLayout("editorial", { feed: "" }).feed).toBe("list"); // "" = inherit
  });
});

/**
 * Guards the constraint that makes themes shippable at all: ~56 files hard-code
 * Tailwind neutrals (`text-white`, `text-gray-200`, `text-gray-400`) that no
 * theme token can reach, because `@theme` extends the palette rather than
 * replacing it. A light theme would therefore render invisible text sitewide
 * (`text-white` on paper is ~1.07:1). Until those utilities are migrated to
 * tokens, EVERY theme must keep a dark `surface-950`. This makes that
 * executable rather than tribal knowledge.
 *
 * `gray-500` is deliberately excluded — it already fails on the DEFAULT theme
 * (4.09:1), so asserting it would fail on main. Tracked separately.
 */
describe("every theme keeps hardcoded body text legible (#250)", () => {
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  // The Tailwind neutrals our components hardcode for body/secondary text.
  const HARDCODED_TEXT = { white: "#ffffff", "gray-200": "#e5e7eb", "gray-400": "#9ca3af" };

  for (const [id, theme] of Object.entries(THEMES)) {
    it(`${id}: white/gray-200/gray-400 stay AA on surface-950`, () => {
      const ground = theme.tokens.colors["surface-950"];
      for (const [name, hex] of Object.entries(HARDCODED_TEXT)) {
        const ratio = contrast(hex, ground);
        expect(ratio, `${name} on ${id} surface-950 (${ground}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("resolveLayout / isFeedVariant (#250 Phase 3)", () => {
  it("isFeedVariant only accepts known feed variants", () => {
    for (const v of FEED_VARIANTS) expect(isFeedVariant(v)).toBe(true);
    expect(isFeedVariant("blog")).toBe(false); // not built yet
    expect(isFeedVariant("")).toBe(false);
  });

  it("defaults to the theme's variant when there's no override", () => {
    expect(resolveLayout("default", {}).feed).toBe("cards");
    expect(resolveLayout("default").feed).toBe("cards"); // overrides optional
    expect(resolveLayout("unknown-theme", {}).feed).toBe("cards"); // resolves to default theme
  });

  it("a known override wins; empty or bad values fall back to the theme default", () => {
    expect(resolveLayout("default", { feed: "list" }).feed).toBe("list");
    expect(resolveLayout("default", { feed: "" }).feed).toBe("cards"); // inherit
    expect(resolveLayout("default", { feed: "nonsense" }).feed).toBe("cards"); // stale/unknown → default
  });
});
