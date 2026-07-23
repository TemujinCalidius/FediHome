/**
 * Theme token contract (#250). A theme is pure data: the design tokens the UI
 * resolves to at runtime. Everything visual references `var(--color-*)` /
 * `var(--font-*)` (see globals.css), so overriding these at `:root:root`
 * re-themes the whole site. Layout/region theming builds on top of this later.
 */
import type { SidebarSide, SidebarBlock } from "@/lib/sidebar";

/**
 * Colour tokens, keyed by their `--color-<token>` custom-property suffix.
 *
 * `content-*` is the text ramp (see `content.ts`): the tokens body copy resolves
 * to, so a theme can move text colour and not only its ground. Components are
 * being migrated onto them from hard-coded Tailwind neutrals — the prerequisite
 * for a light theme, since `@theme` extends the palette and leaves `gray-*`
 * fixed while `surface-*` moves.
 */
export type ColorToken =
  | "surface-950" | "surface-900" | "surface-800" | "surface-700" | "surface-600"
  | "accent-50" | "accent-100" | "accent-200" | "accent-300" | "accent-400"
  | "accent-500" | "accent-600" | "accent-700" | "accent-800" | "accent-900"
  | "moss-400" | "moss-500" | "moss-600"
  | "content" | "content-strong" | "content-muted" | "content-subtle"
  | "content-faint" | "content-dim" | "content-ghost";

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
 * Layout regions (#250). Each region of the page picks one variant from a
 * curated catalogue — that's what makes layout swappable without arbitrary
 * markup. `feed` (Phase 3) and `header` (Phase 4) are wired; shell/post/footer
 * join later behind the same dispatch pattern.
 */
export type FeedVariant = "cards" | "list";
/** How the site header renders: the default top `bar`, a `centered` masthead, or a `minimal` name+menu. */
export type HeaderVariant = "bar" | "centered" | "minimal";
/** How the site footer renders: the default 3-region `row`, a one-line `minimal`, or a `columns` sitemap. */
export type FooterVariant = "row" | "minimal" | "columns";
/**
 * The public page frame: `normal` (each page keeps its own width — today's
 * look), `narrow` (a tighter reading column), or `sidebar` (content beside a
 * column of about/recent/sections/connect blocks — what the Classic Blog theme
 * is built on). `wide` joins in a later phase — see the region table in #250.
 */
export type ShellVariant = "normal" | "narrow" | "sidebar";

export interface LayoutConfig {
  /** How the home/blog feed renders its posts. */
  feed: FeedVariant;
  /** How the site header renders across every page. */
  header: HeaderVariant;
  /** How the site footer renders across every page. */
  footer: FooterVariant;
  /** The frame around every PUBLIC page (the (public) route group). */
  shell: ShellVariant;
}

export interface Theme {
  id: string;
  name: string;
  description?: string;
  tokens: ThemeTokens;
  /** The variant this theme picks for each region (its layout preset). */
  layout: LayoutConfig;
  /**
   * A theme that uses the `sidebar` shell can preset the sidebar's side + block
   * order/visibility (#307). Owner settings still override; omitted → the global
   * defaults (right, all blocks). Only meaningful when `layout.shell === "sidebar"`.
   */
  sidebar?: { side?: SidebarSide; blocks?: SidebarBlock[] };
}
