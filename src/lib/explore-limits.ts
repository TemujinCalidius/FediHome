/**
 * Bounds for the Explore feed's two numbers (#386).
 *
 * A leaf module with no imports, for two reasons that both matter:
 *
 *  - `site-settings.ts` validates against them and `explore.ts` reads its config
 *    from `site-settings.ts`, so putting them in either file would make the pair
 *    a cycle. `uploads-dir.ts` holds the cache-budget bounds for the same reason.
 *  - the settings SCREEN needs them for its `min`/`max` attributes, and that is a
 *    client component. `site-settings.ts` imports Prisma, so importing a value
 *    from it there would drag the database client into the browser bundle.
 *
 * Hardcoding the numbers in the form instead would work right up until someone
 * changes a limit in one place, and then the input silently accepts a value the
 * server refuses.
 */

/**
 * Longest lookback for unresolved reply-parents, in days.
 *
 * Far tighter than the generic 3650-day settings cap on purpose: the per-run
 * fetch budget is ten, so a scan reaching back years would spend it on
 * conversations nobody is reading rather than on this week's.
 */
export const MAX_EXPLORE_LOOKBACK_DAYS = 90;

/** Ceiling on stored reply-parents. A row count, not a day count. */
export const MAX_EXPLORE_STORED = 20_000;

/** Enough for a long scroll, small enough to be unremarkable on any disk. */
export const DEFAULT_EXPLORE_MAX_STORED = 500;
