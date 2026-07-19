import type { ThemeColors } from "./types";
import { DEFAULT_THEME } from "./default";
import { resolveTheme } from "./registry";
import { deriveAccentScale } from "./color";

export type { Theme, ThemeTokens, ThemeColors, ThemeFonts, ThemeFeel, ColorToken, FeedVariant, HeaderVariant, FooterVariant, ShellVariant, LayoutConfig } from "./types";
export { deriveAccentScale } from "./color";
export { DEFAULT_THEME } from "./default";
export { THEMES, THEME_IDS, isThemeId, resolveTheme } from "./registry";
export {
  LAYOUT_REGIONS, FEED_VARIANTS, HEADER_VARIANTS, FOOTER_VARIANTS, SHELL_VARIANTS,
  isFeedVariant, isHeaderVariant, isFooterVariant, isShellVariant, resolveLayout,
} from "./layout";

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The default theme's accent (== its `accent-500`), which is also the
 * `SiteSettings.accentColor` column default. A legacy `accentColor` equal to
 * this is treated as "unset" by `resolveAccent`, so existing instances that
 * never customised their accent keep inheriting the theme's own scale.
 */
export const DEFAULT_ACCENT = DEFAULT_THEME.tokens.colors["accent-500"];

/**
 * Resolve which accent to apply for the active theme (#276). Precedence:
 *   1. a per-theme override (`themeAccents[themeId]`) — an explicit choice, always honoured;
 *   2. else the legacy single `accentColor`, but for the DEFAULT theme only (that's
 *      what the macOS app / pre-#276 installs wrote), and with the schema-default
 *      `#3b82f6` treated as "unset" so a default instance renders identically;
 *   3. else `null` = inherit the theme's own accent.
 * A custom accent no longer silently bleeds onto other themes — it's per-theme now.
 */
export function resolveAccent(
  themeId: string,
  p: { accentColor?: string | null; themeAccents?: Record<string, string> | null },
): string | null {
  const perTheme = p.themeAccents?.[themeId];
  if (perTheme && HEX.test(perTheme)) return perTheme;
  if (
    themeId === DEFAULT_THEME.id &&
    p.accentColor &&
    HEX.test(p.accentColor) &&
    p.accentColor.toLowerCase() !== DEFAULT_ACCENT.toLowerCase()
  ) {
    return p.accentColor;
  }
  return null;
}

/**
 * Build the runtime `<style>` body that applies the active theme + an already-
 * resolved accent, as a `:root:root{…}` block (specificity 0-2-0 beats Tailwind's
 * `@theme` `:root`, so it wins regardless of source order). Emits ONLY the vars
 * that DIFFER from the default theme, so a default instance inheriting its accent
 * injects **nothing** (returns "") and renders identically.
 *
 * `accentColor` here is the *resolved* accent (see `resolveAccent`): a real
 * `#RRGGBB` to overlay, or null/"" to inherit. Any valid hex is overlaid — the
 * inherit-vs-custom decision lives in `resolveAccent`, not here. All emitted
 * values come from our own theme constants or `deriveAccentScale` (which only
 * outputs `#RRGGBB`), never a raw user string — so injecting this inline (CSP
 * allows `style-src 'unsafe-inline'`) carries no injection risk.
 */
export function buildThemeStyle(themeId: string, accentColor?: string | null): string {
  const theme = resolveTheme(themeId);
  const colors: Record<string, string> = { ...theme.tokens.colors };

  // Overlay the resolved accent: derive the whole scale from the picked base.
  if (accentColor && HEX.test(accentColor)) {
    Object.assign(colors, deriveAccentScale(accentColor));
  }

  const def = DEFAULT_THEME.tokens;
  const lines: string[] = [];
  for (const [token, value] of Object.entries(colors)) {
    if (value.toLowerCase() !== (def.colors as ThemeColors)[token as keyof ThemeColors]?.toLowerCase()) {
      lines.push(`--color-${token}:${value}`);
    }
  }
  for (const key of ["display", "body", "mono"] as const) {
    if (theme.tokens.fonts[key] !== def.fonts[key]) lines.push(`--font-${key}:${theme.tokens.fonts[key]}`);
  }
  // Feel tokens (#250): texture. Emit only what differs, keyed to the CSS vars in
  // globals.css. All values are theme constants, so no injection risk.
  const feelVars: Array<[keyof typeof def.feel, string]> = [
    ["radiusCard", "--radius-card"],
    ["radiusButton", "--radius-button"],
    ["glassFilter", "--glass-filter"],
  ];
  for (const [key, cssVar] of feelVars) {
    if (theme.tokens.feel[key] !== def.feel[key]) lines.push(`${cssVar}:${theme.tokens.feel[key]}`);
  }

  return lines.length ? `:root:root{${lines.join(";")}}` : "";
}
