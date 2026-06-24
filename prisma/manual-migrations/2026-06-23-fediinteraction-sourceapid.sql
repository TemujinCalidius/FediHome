-- Dedup incoming Fediverse replies on redelivery (#121).
--
-- Adds FediInteraction.sourceApId: the interacting activity's own apId (a reply
-- Note's id). The inbox dedups a redelivered Create(Note) on this value so it
-- doesn't produce a second bell entry / push. Null for like/boost rows.
--
-- A plain (non-unique) index — NOT a unique constraint — because `prisma db
-- push` (the upgrade path) refuses to add a unique index without
-- --accept-data-loss; dedup is enforced in app code (handleNote) instead.
--
-- Additive and non-destructive — existing rows get NULL.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-06-23-fediinteraction-sourceapid.sql
-- Or (preferred, regenerates from schema.prisma):
--   npx prisma db push

ALTER TABLE "FediInteraction"
  ADD COLUMN IF NOT EXISTS "sourceApId" TEXT;

CREATE INDEX IF NOT EXISTS "FediInteraction_sourceApId_idx"
  ON "FediInteraction"("sourceApId");
