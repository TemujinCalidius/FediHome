-- Delivery markers for scheduled-post publishing (#195). Additive + idempotent.
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "threadsPostId" TEXT;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "federatedAt" TIMESTAMP(3);

-- Backfill: scheduled posts published BEFORE these markers existed already
-- delivered; without this they'd all look "claimed but never federated" and the
-- scheduler would retry them once (risking a duplicate Bluesky crosspost, since
-- the pre-marker scheduler never persisted blueskyUri). Idempotent via the
-- IS NULL guard.
UPDATE "Post"
SET "federatedAt" = "publishedAt"
WHERE "published" = true
  AND "scheduledFor" IS NOT NULL
  AND "federatedAt" IS NULL;
