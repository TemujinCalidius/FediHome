import type { Theme } from "./types";
import { CONTENT_RAMP } from "./content";

/**
 * "Classic Blog" (#250) — the third built-in theme, and the first to lean on the
 * sidebar shell: a left sidebar of bio / recent posts / links beside a compact
 * reading column, warm charcoal ground, a pine-green accent, and serif
 * throughout. A traditional personal-blog counterpoint to the default's cool
 * glass and Editorial's sepia print.
 *
 * **Composition (why these presets).** `shell: "sidebar"` is the whole point;
 * `header: "minimal"` keeps a quiet masthead (name + menu) so the nav isn't
 * duplicated — the sidebar omits `sections` and carries about / recent / connect
 * instead, exactly the combination flagged in #307. `feed: "list"` gives the
 * date-led index a blog wants. An owner can still override any of it.
 *
 * **Why it's dark.** Same reason as Editorial: a light ground is unreachable
 * until the remaining hard-coded `text-white` / `gray-*` utilities become
 * `content-*` tokens, so the contrast invariant in `themes.test.ts` keeps
 * `surface-950` dark. This is a warm *charcoal*, not paper.
 *
 * **Fonts** swap round only (buildThemeStyle can't register `@font-face`): serif
 * display AND serif body — a fully bookish voice, distinct from Editorial's sans
 * headline over serif body. `mono` is untouched, so it diffs out.
 */
export const CLASSIC_THEME: Theme = {
  id: "classic",
  name: "Classic Blog",
  description: "A left sidebar of bio, recent posts and links beside a serif reading column — warm charcoal, pine-green accent.",
  tokens: {
    colors: {
      // Warm neutral charcoal — a hair of warmth, monotonic in luminance.
      "surface-950": "#141310",
      "surface-900": "#1b1916",
      "surface-800": "#24211a",
      "surface-700": "#302b22",
      "surface-600": "#463f33",
      // Pine green — deriveAccentScale("#3f7d5c"), pinned so the theme's identity
      // can't drift if that ramp is ever retuned.
      "accent-50": "#f5f9f7",
      "accent-100": "#e8efeb",
      "accent-200": "#cdddd5",
      "accent-300": "#a9c5b6",
      "accent-400": "#75a18a",
      "accent-500": "#3f7d5c",
      "accent-600": "#376e51",
      "accent-700": "#2d5a42",
      "accent-800": "#234533",
      "accent-900": "#1a3527",
      // Warm gold — the highlight counterpart to the pine accent.
      "moss-400": "#cbb26b",
      "moss-500": "#b0904a",
      "moss-600": "#8a6f38",
      // Text ramp (#250) — unchanged for now: the migration onto these tokens is still in progress, so a warm text ramp would only apply to the already-migrated surfaces.
      ...CONTENT_RAMP,
    },
    fonts: {
      display: '"Source Serif 4", "Georgia", serif',
      body: '"Source Serif 4", "Georgia", serif',
      mono: '"JetBrains Mono", "Fira Code", monospace',
    },
    // Softly rounded, no glass — a calm, paper-like blog rather than frosted glass.
    feel: {
      radiusCard: "8px",
      radiusButton: "6px",
      glassFilter: "none",
    },
  },
  layout: { feed: "list", header: "minimal", footer: "row", shell: "sidebar" },
  // A left sidebar; `sections` omitted so the nav lives once, in the header menu.
  sidebar: { side: "left", blocks: ["about", "recent", "connect"] },
};
