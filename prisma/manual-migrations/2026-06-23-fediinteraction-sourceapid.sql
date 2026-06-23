-- Dedup incoming Fediverse replies on redelivery (#121).
--
-- Adds FediInteraction.sourceApId: the interacting activity's own apId (a reply
-- Note's id). It dedups a redelivered Create(Note) so it doesn't produce a
-- second bell entry / push. Null for like/boost rows (which dedup elsewhere);
-- Postgres treats NULLs as distinct, so the unique index tolerates many nulls.
--
-- Additive and non-destructive — existing rows get NULL.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-06-23-fediinteraction-sourceapid.sql
-- Or (preferred, regenerates from schema.prisma):
--   npx prisma db push

ALTER TABLE "FediInteraction"
  ADD COLUMN IF NOT EXISTS "sourceApId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "FediInteraction_sourceApId_key"
  ON "FediInteraction"("sourceApId");
