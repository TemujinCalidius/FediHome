# Manual migrations

Hand-written SQL applied by `scripts/apply-migrations.sh` **either side of**
every `prisma db push`, on both the container path (`Dockerfile` `CMD`) and the
bare-metal one (`update.sh`). `install.sh` runs it once, after `db push`.

**Why two passes (#410).** The pass *before* `db push` is what stops `db push`
tripping its data-loss guard on an upgrade. But on a **fresh** database there is
nothing to prepare and every file that ALTERs a table can only fail — so before
this they applied on the *next* boot, which nobody is told to perform. Worse, the
creation-guard pattern below was silently disarmed by that ordering: the guarded
body failed on boot 1, `db push` then created the column, and on boot 2 the guard
was false, so the body never ran at all — and the `RAISE NOTICE` never fired
either, so nothing in the log said so.

The second pass costs one connection and a ledger read on an upgrade.

## Why this directory exists

`db push` refuses to add a unique constraint without `--accept-data-loss` — even
a provably safe additive one on a brand-new column. So any change needing one
ships as a `CREATE ... IF NOT EXISTS` file here. Pre-applying it means the
`db push` that follows sees no diff and never trips the guard. (#124)

## These files re-run

Applied files are recorded in the `ManualMigration` table, so each one normally
runs once per content version. **Write them as though they run on every boot
anyway**, because two things bring that back:

- the ledger fails **safe by re-running everything** — if it can't be created or
  read, the runner behaves exactly as it did before it existed;
- **any edit re-runs the file**, since the ledger compares a content hash. Even
  a comment-only change.

## The rule: no bare data changes

> **A backfill's `WHERE` clause is almost never a description of history. It is
> usually a description of the current steady state.**

That sentence is the whole of #384. This shipped, and re-ran on every container
start for weeks:

```sql
UPDATE "Post" SET "federatedAt" = "publishedAt"
 WHERE "published" = true AND "scheduledFor" IS NOT NULL
   AND "federatedAt" IS NULL;
```

It reads as "scheduled posts from before these markers existed". It is in fact
the exact state of **every scheduled post that is mid-delivery right now** — and
it is character-for-character the predicate the retry sweep uses to recover
stranded posts (`src/lib/publish-post.ts`). So each re-run marked live posts
delivered when they weren't, *and* removed them from the only mechanism that
would ever have noticed. Silently, and with no way back.

### The pattern to use instead

Fence the change behind the thing being created not existing yet. Inside that
guard, no row can carry a real value and the app isn't running, so the backfill
is unconditionally correct — and it can never fire twice:

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name   = 'Post'
       AND column_name  = 'federatedAt'
  ) THEN
    ALTER TABLE "Post" ADD COLUMN "federatedAt" TIMESTAMP(3);
    UPDATE "Post" SET "federatedAt" = "publishedAt" WHERE "published" = true;
  END IF;
END $$;
```

When the new value doesn't depend on another column, the column default does the
same job with less ceremony — Postgres applies it to every existing row at
`ADD COLUMN` time, once:

```sql
ALTER TABLE "FediFollowing" ADD COLUMN IF NOT EXISTS "accepted" BOOLEAN NOT NULL DEFAULT true;
```

**A fixed date bound is not a substitute.** An install that has been offline
since before that date publishes its whole overdue backlog on first boot, with
`publishedAt` values from *before* the bound.

### `-- @dml-ok:`

If a data change genuinely is safe to re-run, say why:

```sql
-- @dml-ok: self-extinguishing — after this runs no row matches, and no code
-- path can create a matching row again.
```

`src/lib/__tests__/manual-migrations.test.ts` fails the build on any `UPDATE`,
`INSERT`, `DELETE` or `TRUNCATE` that has neither a creation guard nor this
annotation. Writing the sentence is the point: its absence is what caused #384.

## Conventions

- **Name:** `YYYY-MM-DD-kebab-case.sql`. Execution order is lexicographic, which
  is only date order because of the prefix — and order is a correctness property
  (`2026-07-03` touches a column `2026-07-02` creates).
- **`IF NOT EXISTS` on every `CREATE` / `ADD COLUMN`** outside a guard.
- **Never `DROP` anything.** `db push` owns removal.
- **No `CONCURRENTLY`** — each file runs inside a transaction so it commits with
  its ledger row, and `CREATE INDEX CONCURRENTLY` can't.
- **`RAISE NOTICE` reaches the operator.** The runner forwards notices to the
  boot log, so a migration that did something worth knowing about can say so.

## Running them

```bash
npm run migrate   # or: sh scripts/apply-migrations.sh
```

Against a scratch database, with the real-Postgres tests:

```bash
FEDIHOME_TEST_DATABASE_URL=postgresql://... npx vitest run manual-migrations.pg
```
