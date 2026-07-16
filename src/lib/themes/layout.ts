import type { FeedVariant, LayoutConfig } from "./types";
import { resolveTheme } from "./registry";

/**
 * Layout region catalogue + resolution (#250, Phase 3). A theme picks a variant
 * for each region (its layout preset); the owner can override any single region
 * from config (empty = inherit the theme's default). This is the region×variant
 * model — rich, safe control over a curated set of layout choices, never
 * arbitrary markup. Only the `feed` region is wired today; header/shell/post/
 * footer join the same pattern in later phases.
 */

/** Every layout region and the variants it offers (drives validation + the admin UI). */
export const LAYOUT_REGIONS = {
  feed: {
    label: "Feed",
    variants: ["cards", "list"] as FeedVariant[],
    describe: {
      cards: "Glass cards with cover images — the default, magazine feel.",
      list: "A compact, date-led index — more posts per screen, reading-first.",
    } as Record<FeedVariant, string>,
  },
} as const;

export const FEED_VARIANTS = LAYOUT_REGIONS.feed.variants;

export function isFeedVariant(v: string): v is FeedVariant {
  return (FEED_VARIANTS as readonly string[]).includes(v);
}

/**
 * The active layout: the theme's preset per region, with per-region overrides
 * applied on top. An override is honoured only when it's a known variant;
 * anything else (empty string = "inherit", or a stale/unknown value) falls back
 * to the theme's default, so a default instance renders identically.
 */
export function resolveLayout(
  themeId: string,
  overrides: Partial<Record<keyof LayoutConfig, string>> = {},
): LayoutConfig {
  const base = resolveTheme(themeId).layout;
  return {
    feed: isFeedVariant(overrides.feed ?? "") ? (overrides.feed as FeedVariant) : base.feed,
  };
}
