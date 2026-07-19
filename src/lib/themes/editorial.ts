import type { Theme } from "./types";

/**
 * "Editorial" (#250) — the second built-in theme, and the first proof that the
 * token contract re-themes the whole site: it's pure data, no new machinery.
 * A warm sepia ground with a terracotta accent, serif body copy and a compact
 * list feed — a reading-first counterpoint to the default's cool glassy Cards.
 *
 * **Why it's dark, not paper.** A light theme isn't reachable yet: ~56 files
 * (and the global body class in `app/layout.tsx`) hard-code Tailwind neutrals
 * like `text-white` / `text-gray-200`, which are NOT theme tokens — `@theme`
 * *extends* the palette, so `gray-*` stays fixed while `surface-*` moves. On a
 * paper ground `text-white` lands at 1.07:1 and `text-gray-200` at 1.16:1, i.e.
 * an invisible site. Light themes need those utilities migrated to tokens
 * first; until then every theme must be dark. `themes.test.ts` encodes this as
 * a contrast invariant so it can't be violated by accident.
 *
 * **Why the fonts only swap round.** `buildThemeStyle` can swap font *families*
 * but cannot register `@font-face`, and only Inter + Source Serif 4 are
 * self-hosted. So Editorial inverts the default's pairing — sans headlines over
 * serif body — for a genuinely different voice at zero extra bytes. `mono` is
 * untouched, so it diffs out and is never emitted.
 */
export const EDITORIAL_THEME: Theme = {
  id: "editorial",
  name: "Editorial",
  description: "Warm sepia and terracotta, serif body copy, compact list feed — reading-first.",
  tokens: {
    colors: {
      // Warm sepia ramp — brown undertone, not a hue-rotated blue-black.
      // Verified monotonic in luminance.
      "surface-950": "#17120e",
      "surface-900": "#201a15",
      "surface-800": "#2b231c",
      "surface-700": "#382e25",
      "surface-600": "#504235",
      // Terracotta. Values are deriveAccentScale("#c2663d") — the same ramp a
      // custom accent goes through — pinned here so the shipped theme's identity
      // can't drift if that ramp is ever retuned.
      "accent-50": "#fcf7f5",
      "accent-100": "#f8ede8",
      "accent-200": "#efd7cd",
      "accent-300": "#e4baa8",
      "accent-400": "#d39173",
      "accent-500": "#c2663d",
      "accent-600": "#ab5a36",
      "accent-700": "#8c492c",
      "accent-800": "#6b3822",
      "accent-900": "#512b1a",
      // Sage — the warm counterpart to the default's emerald.
      "moss-400": "#9cb380",
      "moss-500": "#7e9a5f",
      "moss-600": "#63793f",
    },
    fonts: {
      display: '"Inter", system-ui, -apple-system, sans-serif',
      body: '"Source Serif 4", "Georgia", serif',
      mono: '"JetBrains Mono", "Fira Code", monospace',
    },
    // Crisp and flat, not glassy: tight corners and no backdrop blur — the print/
    // editorial counterpoint to the default's rounded frosted glass.
    feel: {
      radiusCard: "4px",
      radiusButton: "4px",
      glassFilter: "none",
    },
  },
  // Reading-first: the compact index, not glass cards. An owner can still
  // override this per-region from Site settings.
  layout: { feed: "list", header: "bar", footer: "row" },
};
