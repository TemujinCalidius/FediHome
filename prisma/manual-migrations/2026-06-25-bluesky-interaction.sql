-- Bluesky interaction ingestion (#134).
--
-- Adds the BlueskyInteraction table: per-actor likes/reposts/mentions/quotes/
-- follows on our posts, ingested from app.bsky.notification.listNotifications
-- into the notification bell + push. Deduped by the notification's own at:// uri
-- (notifUri), since listNotifications is at-least-once.
--
-- Additive and non-destructive — a brand-new table. `prisma db push` creates it
-- (including the unique index) on its own; this file is the manual-apply path
-- for operators who run SQL by hand, and update.sh applies it before db push.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-06-25-bluesky-interaction.sql
-- Or (preferred, regenerates from schema.prisma):
--   npx prisma db push

CREATE TABLE IF NOT EXISTS "BlueskyInteraction" (
  "id"           TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  "notifUri"     TEXT NOT NULL,
  "notifCid"     TEXT NOT NULL,
  "authorDid"    TEXT NOT NULL,
  "authorHandle" TEXT NOT NULL,
  "displayName"  TEXT,
  "avatarUrl"    TEXT,
  "subjectUri"   TEXT,
  "postUri"      TEXT,
  "content"      TEXT,
  "reason"       TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL,
  "fetchedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlueskyInteraction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BlueskyInteraction_notifUri_key" ON "BlueskyInteraction"("notifUri");
CREATE INDEX IF NOT EXISTS "BlueskyInteraction_type_idx" ON "BlueskyInteraction"("type");
CREATE INDEX IF NOT EXISTS "BlueskyInteraction_subjectUri_idx" ON "BlueskyInteraction"("subjectUri");
CREATE INDEX IF NOT EXISTS "BlueskyInteraction_createdAt_idx" ON "BlueskyInteraction"("createdAt");
