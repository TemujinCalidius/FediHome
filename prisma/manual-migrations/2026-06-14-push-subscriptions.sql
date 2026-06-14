-- Manual migration for Web Push (PWA notifications).
-- Adds the PushSubscription table that stores the owner's browser/device push
-- endpoints (one row per installed PWA / browser that enabled notifications).
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-06-14-push-subscriptions.sql
-- Or (preferred, regenerates from schema.prisma):
--   npx prisma db push

CREATE TABLE IF NOT EXISTS "PushSubscription" (
  "id"         TEXT NOT NULL,
  "endpoint"   TEXT NOT NULL,
  "p256dh"     TEXT NOT NULL,
  "auth"       TEXT NOT NULL,
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "failures"   INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
