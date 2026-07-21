import { describe, it, expect } from "vitest";
import {
  deriveAccentScale, resolveTheme, isThemeId, buildThemeStyle, resolveAccent, DEFAULT_ACCENT, DEFAULT_THEME,
  isFeedVariant, isHeaderVariant, isFooterVariant, isShellVariant, resolveLayout,
  FEED_VARIANTS, HEADER_VARIANTS, FOOTER_VARIANTS, SHELL_VARIANTS, THEMES,
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
  it("injects NOTHING for the default theme with no accent (inherit)", () => {
    expect(buildThemeStyle("default", null)).toBe("");
    expect(buildThemeStyle("default", undefined)).toBe("");
    expect(buildThemeStyle("default", "")).toBe("");
    expect(buildThemeStyle("unknown-id", null)).toBe(""); // resolves to default
  });

  it("emits a :root:root override scale for any custom accent colour", () => {
    const css = buildThemeStyle("default", "#22c55e");
    expect(css.startsWith(":root:root{")).toBe(true);
    expect(css).toContain("--color-accent-500:#22c55e");
    expect(css).toContain("--color-accent-400:"); // the derived lighter shade too
    // Only accent vars change — surfaces/fonts stay default (not emitted).
    expect(css).not.toContain("--color-surface-950");
    expect(css).not.toContain("--font-display");
  });

  it("overlays ANY valid hex now — the inherit-vs-custom decision lives in resolveAccent (#276)", () => {
    // The old DEFAULT_ACCENT no-op guard is gone: a resolved accent is always
    // overlaid. So blue is finally selectable on Editorial (the trap fix).
    const derived = deriveAccentScale(DEFAULT_ACCENT);
    const css = buildThemeStyle("editorial", DEFAULT_ACCENT);
    // accent-500 == the default theme's accent-500, so it diffs out (falls through
    // to the @theme base); a derived shade proves the blue overlay was applied.
    expect(css).toContain(`--color-accent-600:${derived["accent-600"]}`);
    expect(css).toContain("--color-surface-950:#17120e"); // Editorial's surfaces still there
  });
});

describe("resolveAccent (#276) — per-theme accent with inherit", () => {
  it("an unset default instance inherits (→ null → no injection, pixel-identical)", () => {
    expect(resolveAccent("default", { accentColor: DEFAULT_ACCENT, themeAccents: {} })).toBeNull();
    expect(resolveAccent("default", { accentColor: "#3B82F6", themeAccents: {} })).toBeNull(); // case-insensitive
    expect(buildThemeStyle("default", resolveAccent("default", { accentColor: DEFAULT_ACCENT, themeAccents: {} }))).toBe("");
  });

  it("a legacy custom accentColor applies to the DEFAULT theme only", () => {
    expect(resolveAccent("default", { accentColor: "#22c55e", themeAccents: {} })).toBe("#22c55e");
    // ...and does NOT bleed onto other themes anymore (the per-theme fix):
    expect(resolveAccent("editorial", { accentColor: "#22c55e", themeAccents: {} })).toBeNull();
  });

  it("a per-theme override wins, and lets you pick blue on Editorial", () => {
    expect(resolveAccent("editorial", { accentColor: DEFAULT_ACCENT, themeAccents: { editorial: "#22c55e" } })).toBe("#22c55e");
    expect(resolveAccent("editorial", { themeAccents: { editorial: DEFAULT_ACCENT } })).toBe(DEFAULT_ACCENT);
    expect(resolveAccent("default", { accentColor: DEFAULT_ACCENT, themeAccents: { default: "#22c55e" } })).toBe("#22c55e");
  });

  it("ignores junk / missing entries and inherits", () => {
    expect(resolveAccent("editorial", { themeAccents: { editorial: "not-a-hex" } })).toBeNull();
    expect(resolveAccent("editorial", {})).toBeNull();
    expect(resolveAccent("default", {})).toBeNull();
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

  it("emits its crisp/flat feel tokens (texture), diffing out the ones it shares (#250)", () => {
    const css = buildThemeStyle("editorial", null);
    expect(css).toContain("--radius-card:4px");
    expect(css).toContain("--radius-button:4px");
    expect(css).toContain("--glass-filter:none");
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

describe("resolveLayout / isHeaderVariant (#250 Phase 4 — header region)", () => {
  it("isHeaderVariant only accepts known header variants", () => {
    for (const v of HEADER_VARIANTS) expect(isHeaderVariant(v)).toBe(true);
    expect(isHeaderVariant("sidebar")).toBe(false); // not built yet
    expect(isHeaderVariant("")).toBe(false);
  });

  it("both built-in themes default to the bar header (existing instances unchanged)", () => {
    expect(resolveLayout("default", {}).header).toBe("bar");
    expect(resolveLayout("editorial", {}).header).toBe("bar");
    expect(resolveLayout("unknown-theme", {}).header).toBe("bar"); // resolves to default theme
  });

  it("a known override wins; empty or bad values fall back to the theme default", () => {
    expect(resolveLayout("default", { header: "centered" }).header).toBe("centered");
    expect(resolveLayout("default", { header: "minimal" }).header).toBe("minimal");
    expect(resolveLayout("default", { header: "" }).header).toBe("bar"); // inherit
    expect(resolveLayout("default", { header: "nonsense" }).header).toBe("bar"); // stale/unknown → default
  });

  it("resolves feed and header independently", () => {
    const r = resolveLayout("default", { feed: "list", header: "minimal" });
    expect(r).toMatchObject({ feed: "list", header: "minimal" });
  });
});

describe("resolveLayout / isFooterVariant (#250 — footer region)", () => {
  it("isFooterVariant only accepts known footer variants", () => {
    for (const v of FOOTER_VARIANTS) expect(isFooterVariant(v)).toBe(true);
    expect(isFooterVariant("sidebar")).toBe(false); // not a footer variant
    expect(isFooterVariant("")).toBe(false);
  });

  it("both built-in themes default to the row footer (existing instances unchanged)", () => {
    expect(resolveLayout("default", {}).footer).toBe("row");
    expect(resolveLayout("editorial", {}).footer).toBe("row");
    expect(resolveLayout("unknown-theme", {}).footer).toBe("row"); // resolves to default theme
  });

  it("a known override wins; empty or bad values fall back to the theme default", () => {
    expect(resolveLayout("default", { footer: "minimal" }).footer).toBe("minimal");
    expect(resolveLayout("default", { footer: "columns" }).footer).toBe("columns");
    expect(resolveLayout("default", { footer: "" }).footer).toBe("row"); // inherit
    expect(resolveLayout("default", { footer: "nonsense" }).footer).toBe("row"); // stale/unknown → default
  });

  it("resolves feed, header and footer independently", () => {
    expect(resolveLayout("default", { feed: "list", header: "minimal", footer: "columns" }))
      .toMatchObject({ feed: "list", header: "minimal", footer: "columns" });
  });
});

describe("resolveLayout / isShellVariant (#250 — public shell region)", () => {
  it("isShellVariant only accepts known shell variants", () => {
    for (const v of SHELL_VARIANTS) expect(isShellVariant(v)).toBe(true);
    expect(isShellVariant("sidebar")).toBe(true); // shipped — the Classic Blog frame
    expect(isShellVariant("wide")).toBe(false); // still a later phase
    expect(isShellVariant("")).toBe(false);
  });

  it("both built-in themes default to the normal shell (existing instances unchanged)", () => {
    expect(resolveLayout("default", {}).shell).toBe("normal");
    expect(resolveLayout("editorial", {}).shell).toBe("normal");
    expect(resolveLayout("unknown-theme", {}).shell).toBe("normal");
  });

  it("a known override wins; empty or bad values fall back to the theme default", () => {
    expect(resolveLayout("default", { shell: "narrow" }).shell).toBe("narrow");
    expect(resolveLayout("default", { shell: "sidebar" }).shell).toBe("sidebar");
    expect(resolveLayout("default", { shell: "" }).shell).toBe("normal"); // inherit
    expect(resolveLayout("default", { shell: "wide" }).shell).toBe("normal"); // not built yet → default
  });

  it("neither built-in theme opts into the sidebar (owner opt-in only)", () => {
    expect(resolveLayout("default", {}).shell).toBe("normal");
    expect(resolveLayout("editorial", {}).shell).toBe("normal");
  });

  it("resolves all four regions independently", () => {
    expect(resolveLayout("default", { feed: "list", header: "minimal", footer: "columns", shell: "narrow" }))
      .toEqual({ feed: "list", header: "minimal", footer: "columns", shell: "narrow" });
  });
});
