-- Persisted follower-delivery retry queue (#207). Additive + idempotent.
CREATE TABLE IF NOT EXISTS "FailedDelivery" (
  "id"          TEXT NOT NULL,
  "inbox"       TEXT NOT NULL,
  "activityId"  TEXT NOT NULL,
  "activity"    TEXT NOT NULL,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3) NOT NULL,
  "lastError"   TEXT,
  "failedAt"    TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FailedDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "FailedDelivery_activityId_inbox_key" ON "FailedDelivery"("activityId", "inbox");
CREATE INDEX IF NOT EXISTS "FailedDelivery_nextRetryAt_idx" ON "FailedDelivery"("nextRetryAt");
