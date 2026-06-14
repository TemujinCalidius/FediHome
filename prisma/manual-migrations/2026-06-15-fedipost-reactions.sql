-- Track whether the site owner has liked / boosted a feed post, so the feed's
-- like/boost button state survives a page reload.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-06-15-fedipost-reactions.sql
-- Or:
--   npx prisma db push

ALTER TABLE "FediPost"
  ADD COLUMN IF NOT EXISTS "likedByMe"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "boostedByMe" BOOLEAN NOT NULL DEFAULT false;
