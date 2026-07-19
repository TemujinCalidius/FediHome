/**
 * Theme token contract (#250). A theme is pure data: the design tokens the UI
 * resolves to at runtime. Everything visual references `var(--color-*)` /
 * `var(--font-*)` (see globals.css), so overriding these at `:root:root`
 * re-themes the whole site. Layout/region theming builds on top of this later.
 */

/** Colour tokens, keyed by their `--color-<token>` custom-property suffix. */
export type ColorToken =
  | "surface-950" | "surface-900" | "surface-800" | "surface-700" | "surface-600"
  | "accent-50" | "accent-100" | "accent-200" | "accent-300" | "accent-400"
  | "accent-500" | "accent-600" | "accent-700" | "accent-800" | "accent-900"
  | "moss-400" | "moss-500" | "moss-600";

export type ThemeColors = Record<ColorToken, string>;

export interface ThemeFonts {
  display: string;
  body: string;
  mono: string;
}

/**
 * "Feel" tokens (#250) — texture, not colour: how rounded and how glassy the UI
 * is, so themes can differ in *feel* and not just hue/type. Values are whole CSS
 * values (e.g. `"12px"`, `"blur(12px)"`, `"none"`) — `glassFilter` is the entire
 * `backdrop-filter`, so a theme can turn glass off with `"none"` (a `blur(0px)`
 * would still create a compositing layer). Keyed to `--radius-card` /
 * `--radius-button` / `--glass-filter` in globals.css.
 */
export interface ThemeFeel {
  radiusCard: string;
  radiusButton: string;
  glassFilter: string;
}

export interface ThemeTokens {
  colors: ThemeColors;
  fonts: ThemeFonts;
  feel: ThemeFeel;
}

/**
 * Layout regions (#250, Phase 3). Each region of the page picks one variant from
 * a curated catalogue — that's what makes layout swappable without arbitrary
 * markup. Today only `feed` is wired (cards ↔ list); header/shell/post/footer
 * land in later phases behind the same dispatch pattern.
 */
export type FeedVariant = "cards" | "list";

export interface LayoutConfig {
  /** How the home/blog feed renders its posts. */
  feed: FeedVariant;
}

export interface Theme {
  id: string;
  name: string;
  description?: string;
  tokens: ThemeTokens;
  /** The variant this theme picks for each region (its layout preset). */
  layout: LayoutConfig;
}
