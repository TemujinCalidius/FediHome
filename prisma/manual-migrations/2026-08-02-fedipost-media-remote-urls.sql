-- Manual migration for #478. Additive + idempotent.
--
-- Adds FediPost."mediaRemoteUrls", the ORIGINAL remote URL for each entry in
-- mediaUrls, parallel to it.
--
-- Why: trimFediStorage() unlinks cached files when the cache goes over budget
-- and changes nothing else. The remote original was never kept, so every post
-- referencing an evicted file rendered a broken image, permanently, with no way
-- to re-fetch. Eviction is by age, so it took the oldest media first — posts far
-- enough down the timeline that nobody scrolls to them today, which is why the
-- damage appeared gradually and long after the trim that caused it.
--
-- With this column the trim can put the row back to loading from source instead.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-08-02-fedipost-media-remote-urls.sql
-- Or (preferred, regenerates from schema.prisma):
--   npx prisma db push
--
-- No backfill. Existing rows have no remote URL recorded anywhere to backfill
-- FROM — the proxying discarded it. They keep today's behaviour: an evicted file
-- leaves a broken image. New rows are protected from the moment this ships.

ALTER TABLE "FediPost"
  ADD COLUMN IF NOT EXISTS "mediaRemoteUrls" TEXT[] NOT NULL DEFAULT '{}';
