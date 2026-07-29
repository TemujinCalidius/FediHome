import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * A lint over `prisma/manual-migrations/*.sql` (#384).
 *
 * These files are applied by `scripts/apply-migrations.sh` before every
 * `db push` — historically on **every container start**, and still on every
 * boot whenever the ledger is unavailable. The convention has always been "every
 * file must be idempotent", but that was a comment in a shell script, and it
 * failed exactly once, in the file whose own header claimed idempotency:
 *
 *   UPDATE "Post" SET "federatedAt" = "publishedAt"
 *    WHERE "published" = true AND "scheduledFor" IS NOT NULL
 *      AND "federatedAt" IS NULL;
 *
 * That `WHERE` clause reads like a description of history — "posts from before
 * the markers existed" — but it is a description of the **present**: it is the
 * exact state of every scheduled post that is mid-delivery right now, and it is
 * character-for-character the predicate the retry sweep uses to recover stranded
 * posts (`src/lib/publish-post.ts`). Re-running it marked live posts delivered
 * when they weren't, and stole them from the only mechanism that would have
 * retried them.
 *
 * So: DDL guarded by IF NOT EXISTS is fine. Data changes are not, unless they
 * are either fenced behind a creation-time guard or carry an explicit
 * `-- @dml-ok:` annotation saying why re-running them is safe. Writing that
 * sentence is the point — its absence is what caused #384.
 */

const DIR = path.join(process.cwd(), "prisma", "manual-migrations");

/** Strip `--` line comments and `/* *\/` blocks so keywords in prose don't trip the lint. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Does the file fence its statements behind a runtime existence check?
 *
 * The sanctioned shape is a `DO $$ ... $$` block testing `information_schema`
 * (or `pg_catalog`), so the body runs only when the thing being created does not
 * exist yet — which for a backfill means "no row can carry a real value yet, and
 * the app is not running". That is the general form of the `ADD COLUMN ...
 * DEFAULT` trick, for a backfill that references another column and so can't be
 * expressed as a DEFAULT.
 */
function hasCreationGuard(sql: string): boolean {
  const body = stripComments(sql);
  if (!/\bDO\s*\$\$/i.test(body)) return false;
  return /information_schema|pg_catalog/i.test(body);
}

const DML = /\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/i;
const DESTRUCTIVE_DDL = /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|SCHEMA)\b/i;

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("prisma/manual-migrations", () => {
  it("has migrations to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  describe.each(files)("%s", (name) => {
    const raw = readFileSync(path.join(DIR, name), "utf8");
    const body = stripComments(raw);

    it("is named YYYY-MM-DD-kebab-case.sql", () => {
      // Execution order is the shell glob's lexicographic order, which is only
      // date order because of this naming. Ordering is a correctness property:
      // 2026-07-03 touches a column 2026-07-02 creates.
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.sql$/);
    });

    it("changes data only behind a creation guard or an explicit @dml-ok", () => {
      if (!DML.test(body)) return;
      const annotated = /--\s*@dml-ok:\s*\S/.test(raw);
      const guarded = hasCreationGuard(raw);
      expect(
        annotated || guarded,
        `${name} changes data but is neither fenced behind a creation-time guard nor annotated. ` +
          `These files re-run. If re-running it is genuinely safe, say why in a "-- @dml-ok: <reason>" ` +
          `comment; if it isn't, fence it (see prisma/manual-migrations/README.md).`,
      ).toBe(true);
    });

    it("never drops anything", () => {
      // A migration that can re-run must never be destructive, and `db push`
      // owns schema removal anyway.
      expect(DESTRUCTIVE_DDL.test(body), `${name} contains a DROP`).toBe(false);
    });

    it("does not use CONCURRENTLY", () => {
      // The runner wraps each file in a transaction so the file and its ledger
      // row commit together; CREATE INDEX CONCURRENTLY cannot run in one.
      expect(/\bCONCURRENTLY\b/i.test(body), `${name} uses CONCURRENTLY`).toBe(false);
    });

    it("creates tables and columns idempotently", () => {
      // Everything outside a creation guard must tolerate already existing.
      if (hasCreationGuard(raw)) return;
      for (const stmt of body.split(";")) {
        if (/\bCREATE\s+(TABLE|(UNIQUE\s+)?INDEX)\b/i.test(stmt)) {
          expect(/\bIF\s+NOT\s+EXISTS\b/i.test(stmt), `missing IF NOT EXISTS: ${stmt.trim().slice(0, 90)}`).toBe(true);
        }
        if (/\bALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b/i.test(stmt)) {
          expect(/\bIF\s+NOT\s+EXISTS\b/i.test(stmt), `missing IF NOT EXISTS: ${stmt.trim().slice(0, 90)}`).toBe(true);
        }
      }
    });
  });
});
