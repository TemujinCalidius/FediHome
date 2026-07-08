-- Persisted crosspost retry queue (#225). Additive + idempotent.
CREATE TABLE IF NOT EXISTS "FailedCrosspost" (
  "id"          TEXT NOT NULL,
  "postId"      TEXT NOT NULL,
  "platform"    TEXT NOT NULL,
  "payload"     TEXT NOT NULL,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "nextRetryAt" TIMESTAMP(3) NOT NULL,
  "lastError"   TEXT,
  "failedAt"    TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FailedCrosspost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "FailedCrosspost_postId_platform_key" ON "FailedCrosspost"("postId", "platform");
CREATE INDEX IF NOT EXISTS "FailedCrosspost_nextRetryAt_idx" ON "FailedCrosspost"("nextRetryAt");
