import type { Theme } from "./types";
import { DEFAULT_THEME } from "./default";
import { EDITORIAL_THEME } from "./editorial";
import { CLASSIC_THEME } from "./classic";

/**
 * Registry of built-in themes (#250). Adding a theme is one entry here plus one
 * data file — `buildThemeStyle` diffs its tokens against the default and injects
 * the delta at runtime, and `resolveLayout` picks up its layout preset, so no
 * other wiring is needed. Kept in its own module so `layout.ts` can resolve a
 * theme without a barrel-import cycle through `index.ts`.
 *
 * Note every theme must be DARK for now — see the contrast constraint documented
 * in `editorial.ts` and enforced by the invariant in `themes.test.ts`.
 */
export const THEMES: Record<string, Theme> = {
  [DEFAULT_THEME.id]: DEFAULT_THEME,
  [EDITORIAL_THEME.id]: EDITORIAL_THEME,
  [CLASSIC_THEME.id]: CLASSIC_THEME,
};

export const THEME_IDS = Object.keys(THEMES);

export function isThemeId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(THEMES, id);
}

/** The active theme, falling back to the default for an unknown id. */
export function resolveTheme(id: string): Theme {
  return THEMES[id] ?? DEFAULT_THEME;
}
