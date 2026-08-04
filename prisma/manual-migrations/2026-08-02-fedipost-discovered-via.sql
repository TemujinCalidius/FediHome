-- Manual migration for #386 (Explore feed). Additive, idempotent, DDL only.
--
-- Records WHY a FediPost row exists when it isn't the owner's own feed:
--   NULL           feed content — a follow posted it, or the owner did
--   'boost'        a follow boosted it, so the author may be a stranger
--   'reply-parent' a follow replied to it, and the resolver fetched the post
--                  being replied to
--
-- NULL is deliberately the default, and the safe one. Every existing row is
-- feed content by definition, and every timeline read filters on
-- `discoveredVia: null`, so an upgrade that applies the column and nothing else
-- leaves all four feeds showing exactly what they showed before.
--
-- No backfill, and none is needed: rows written before the column existed cannot
-- have arrived by a path that did not yet exist. Boost rows stay NULL and are
-- still kept off the feeds by the `boostedBy` clause that has always been there.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-08-02-fedipost-discovered-via.sql
-- Or (preferred): npx prisma db push

ALTER TABLE "FediPost" ADD COLUMN IF NOT EXISTS "discoveredVia" TEXT;

CREATE INDEX IF NOT EXISTS "FediPost_discoveredVia_idx"
  ON "FediPost"("discoveredVia");
