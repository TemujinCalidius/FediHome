/**
 * Keyset (seek) pagination on `(publishedAt, id)` (#206).
 *
 * Paginating on `publishedAt` alone with a strict `lt` drops EVERY row sharing
 * the boundary timestamp: if the last row of a page and the first row of the
 * next share an identical millisecond `publishedAt`, `lt` excludes them all and
 * the tied post is silently skipped. A compound cursor with `id` as a unique
 * tiebreak fixes it.
 *
 * The cursor token is `"<publishedAt ISO>_<id>"`. An ISO timestamp contains no
 * `_` and a cuid is `[a-z0-9]`, so the first `_` is an unambiguous separator.
 * A legacy plain-ISO token (issued before this change, still held by an
 * in-flight client) parses with an empty id and falls back to the old strict
 * `lt` — correct, just without the tiebreak until the next page.
 */

export interface Cursor {
  publishedAt: Date;
  id: string; // "" for a legacy plain-ISO cursor
}

export function parseCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  const sep = raw.indexOf("_");
  const isoPart = sep === -1 ? raw : raw.slice(0, sep);
  const date = new Date(isoPart);
  if (isNaN(date.getTime())) return null;
  return { publishedAt: date, id: sep === -1 ? "" : raw.slice(sep + 1) };
}

export function encodeCursor(publishedAt: Date, id: string): string {
  return `${publishedAt.toISOString()}_${id}`;
}

/**
 * The `where` fragment that seeks strictly past the cursor, in DESC order.
 * Merge into the query's `where` (top-level keys are ANDed by Prisma).
 */
export function cursorWhere(c: Cursor): Record<string, unknown> {
  if (!c.id) {
    // Legacy cursor without a tiebreak — preserve the old strict behavior.
    return { publishedAt: { lt: c.publishedAt } };
  }
  return {
    OR: [
      { publishedAt: { lt: c.publishedAt } },
      { publishedAt: c.publishedAt, id: { lt: c.id } },
    ],
  };
}

/** The matching DESC order — must include `id` so the seek is total. */
export const CURSOR_ORDER = [{ publishedAt: "desc" as const }, { id: "desc" as const }];
