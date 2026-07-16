import type { ThemeColors } from "./types";
import { DEFAULT_THEME } from "./default";
import { resolveTheme } from "./registry";
import { deriveAccentScale } from "./color";

export type { Theme, ThemeTokens, ThemeColors, ThemeFonts, ColorToken, FeedVariant, LayoutConfig } from "./types";
export { deriveAccentScale } from "./color";
export { DEFAULT_THEME } from "./default";
export { THEMES, THEME_IDS, isThemeId, resolveTheme } from "./registry";
export { LAYOUT_REGIONS, FEED_VARIANTS, isFeedVariant, resolveLayout } from "./layout";

// The owner's accent default (profile.accentColor, #201) — matches accent-500.
const DEFAULT_ACCENT = "#3b82f6";
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Build the runtime `<style>` body that applies the active theme + the owner's
 * accent colour, as a `:root:root{…}` block (specificity 0-2-0 beats Tailwind's
 * `@theme` `:root`, so it wins regardless of source order). Emits ONLY the vars
 * that DIFFER from the default theme, so a default instance with the default
 * accent injects **nothing** (returns "") and renders identically.
 *
 * All emitted values come from our own theme constants or `deriveAccentScale`
 * (which only outputs `#RRGGBB`), never a raw user string — so injecting this
 * inline (CSP allows `style-src 'unsafe-inline'`) carries no injection risk.
 */
export function buildThemeStyle(themeId: string, accentColor?: string | null): string {
  const theme = resolveTheme(themeId);
  const colors: Record<string, string> = { ...theme.tokens.colors };

  // Overlay a custom accent: derive the whole scale from the picked base.
  if (accentColor && HEX.test(accentColor) && accentColor.toLowerCase() !== DEFAULT_ACCENT) {
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

  return lines.length ? `:root:root{${lines.join(";")}}` : "";
}
