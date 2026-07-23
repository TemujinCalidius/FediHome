import type { ColorToken } from "./types";

/**
 * The text/content ramp (#250) — the tokens body copy resolves to, so a theme
 * can move text colour and not just its background.
 *
 * **Why this exists.** Components hard-coded Tailwind neutrals (`text-white`,
 * `text-gray-400`, …) for every piece of text. `@theme` *extends* Tailwind's
 * palette rather than replacing it, so those neutrals stay fixed while
 * `surface-*` moves — which is precisely why every theme has had to be dark: on
 * a paper ground `text-white` lands around 1:1, an invisible site. Migrating
 * those utilities onto these tokens is what makes a light theme (and the
 * in-admin custom palette) reachable.
 *
 * **The values are Tailwind v4's own neutrals**, so the migration is a pure
 * rename with no visual change. Note they are NOT the v3 hexes people remember
 * (`gray-500` is `#6a7282` here, not `#6b7280`) — v4 regenerated the palette in
 * oklch. `globals.css` defaults each token to `var(--color-gray-*)` so the
 * default theme renders the Tailwind colour *exactly*; these hexes are the same
 * colours written in sRGB, used for diffing in `buildThemeStyle` and for the
 * contrast maths in `themes.test.ts`.
 *
 * Ordered brightest → dimmest. A theme spreads this and overrides only what it
 * wants to move.
 */
export const CONTENT_RAMP: Record<Extract<ColorToken, `content${string}`>, string> = {
  /** Primary text — headings, body copy. Was `text-white`. */
  content: "#ffffff",
  /** Just under primary. Was `text-gray-200`. */
  "content-strong": "#e5e7eb",
  /** Secondary copy. Was `text-gray-300`. */
  "content-muted": "#d1d5dc",
  /** Tertiary — labels, captions. Was `text-gray-400`. */
  "content-subtle": "#99a1af",
  /** Metadata — timestamps, counts, bylines. Was `text-gray-500`. */
  "content-faint": "#6a7282",
  /** Decorative or de-emphasised. Was `text-gray-600`. */
  "content-dim": "#4a5565",
  /** The quietest step — separators, hairline text. Was `text-gray-700`. */
  "content-ghost": "#364153",
};
