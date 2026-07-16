import type { Theme } from "./types";
import { DEFAULT_THEME } from "./default";

/**
 * Registry of built-in themes (#250). Layout/region variants + more presets
 * (e.g. a "Classic Blog" theme) land in later phases; today there's just the
 * default, but the machinery — selection, resolution, runtime injection — is
 * in place. Kept in its own module so `layout.ts` can resolve a theme without a
 * barrel-import cycle through `index.ts`.
 */
export const THEMES: Record<string, Theme> = {
  [DEFAULT_THEME.id]: DEFAULT_THEME,
};

export const THEME_IDS = Object.keys(THEMES);

export function isThemeId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(THEMES, id);
}

/** The active theme, falling back to the default for an unknown id. */
export function resolveTheme(id: string): Theme {
  return THEMES[id] ?? DEFAULT_THEME;
}
