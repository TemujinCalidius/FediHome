-- App API audit log (#158): AppTokenUsage.
--
-- A best-effort, coarse per-request trail (method + path) for connected apps, so
-- the owner can see which token/app performed which write action and when. Only
-- NON-GET bearer requests are recorded; the table is pruned to a rolling 30-day
-- window on the health check.
--
-- Additive and non-destructive: a brand-new table. `prisma db push` creates it
-- without --accept-data-loss.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-07-01-app-token-usage.sql
-- Or (preferred):
--   npx prisma db push

CREATE TABLE IF NOT EXISTS "AppTokenUsage" (
  "id"       TEXT NOT NULL,
  "tokenId"  TEXT,
  "clientId" TEXT,
  "label"    TEXT NOT NULL,
  "scope"    TEXT NOT NULL,
  "method"   TEXT NOT NULL,
  "path"     TEXT NOT NULL,
  "at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppTokenUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AppTokenUsage_at_idx" ON "AppTokenUsage"("at");
