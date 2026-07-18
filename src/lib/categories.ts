/**
 * Gallery categories (#284) — the single source of truth + pure helpers for the
 * photo / video / audio category lists. Kept prisma-free / server-only-free so
 * both server pages AND client components (compose form, gallery grids) can
 * import it (same reasoning that keeps `@/lib/themes` client-safe).
 *
 * The allowed set used to be hard-coded in four places (the photo gallery filter
 * + the three compose dropdowns) with no shared source and no validation. Now the
 * owner edits comma-separated lists in Admin → Site settings; blank falls back to
 * DEFAULT_CATEGORIES here, so existing instances are unchanged.
 */

export type MediaKind = "photos" | "videos" | "audio";

/**
 * The built-in default lists — the exact values that were hard-coded before
 * #284. The single source of truth: an empty config resolves to these, so the
 * compose dropdowns and gallery filters all agree.
 */
export const DEFAULT_CATEGORIES: Record<MediaKind, string[]> = {
  photos: ["wildlife", "macro", "landscape", "street", "general"],
  videos: ["general", "lore", "tutorial", "walk"],
  audio: ["general", "music", "talk", "ambient"],
};

/** Every category resolves to at least this bucket, so a gallery is never empty/filterless. */
export const FALLBACK_CATEGORY = "general";

/** Cap on how many categories an owner can configure per media type. */
export const MAX_CATEGORIES = 24;

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Parse a comma-separated category string into clean slugs: trim, lowercase,
 * keep only URL-safe `[a-z0-9-]` tokens (categories flow into `where:{category}`
 * queries and could later appear in URLs), dedupe, cap at MAX_CATEGORIES.
 * A blank/garbage string yields `[]` (→ callers fall back to the defaults).
 */
export function parseCategoryList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  const out: string[] = [];
  for (const raw of csv.split(",")) {
    const slug = raw.trim().toLowerCase();
    if (SLUG_RE.test(slug) && !out.includes(slug)) out.push(slug);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

/**
 * The effective configured list for a media type: the parsed list, or the
 * built-in default when empty, and always ending with the `general` fallback
 * bucket so `category || "general"` writes always land in a visible tab.
 */
export function resolveCategoryList(parsed: string[], kind: MediaKind): string[] {
  const base = parsed.length ? parsed : DEFAULT_CATEGORIES[kind];
  return base.includes(FALLBACK_CATEGORY) ? base : [...base, FALLBACK_CATEGORY];
}

/** slug → display label, auto title-cased per hyphen word: "photo-walk" → "Photo Walk". */
export function categoryLabel(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The gallery filter list: the configured list first (owner's order), then any
 * category actually present in the DB that isn't already listed. This is the
 * orphan-safety rule — removing a category from the config NEVER hides existing
 * media, it just drops the tab (unless items still use it, in which case it stays).
 */
export function unionCategories(configured: string[], present: (string | null | undefined)[]): string[] {
  const out = [...configured];
  for (const raw of present) {
    const slug = (raw ?? "").trim().toLowerCase();
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/** {key,label}[] for a filter tab bar, with a leading "All" pseudo-category. */
export function buildCategoryTabs(cats: string[]): { key: string; label: string }[] {
  return [{ key: "all", label: "All" }, ...cats.map((c) => ({ key: c, label: categoryLabel(c) }))];
}

/** Write-side guard: a URL-safe slug, else the fallback bucket. */
export function normalizeCategory(raw: string | null | undefined): string {
  const slug = (raw ?? "").trim().toLowerCase();
  return SLUG_RE.test(slug) ? slug : FALLBACK_CATEGORY;
}
