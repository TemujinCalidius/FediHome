-- Block tracking (#180): BlockedActor.
--
-- The `block` action already unfollows, delivers a Block, and purges the actor's
-- content — but recorded nothing, so blocks weren't listable or reversible. This
-- table records each block so it can be listed (GET /api/graph) and undone
-- (unblock → Undo Block).
--
-- Additive and non-destructive: a brand-new table. `prisma db push` creates it
-- (incl. the unique index) without --accept-data-loss.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-07-02-blocked-actor.sql
-- Or (preferred):
--   npx prisma db push

CREATE TABLE IF NOT EXISTS "BlockedActor" (
  "id"          TEXT NOT NULL,
  "actorUri"    TEXT NOT NULL,
  "handle"      TEXT,
  "displayName" TEXT,
  "avatarUrl"   TEXT,
  "inbox"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlockedActor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BlockedActor_actorUri_key" ON "BlockedActor"("actorUri");
