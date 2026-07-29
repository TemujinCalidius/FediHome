-- Delivery markers for scheduled-post publishing (#195). Additive + idempotent.
--
-- THE BACKFILL IS FENCED BEHIND THE COLUMN NOT EXISTING YET, and that fence is
-- the entire point (#384).
--
-- This file is re-applied whenever the migration ledger is unavailable, and was
-- re-applied on EVERY container start before the ledger existed. Its original
-- backfill read:
--
--     UPDATE "Post" SET "federatedAt" = "publishedAt"
--      WHERE "published" = true AND "scheduledFor" IS NOT NULL
--        AND "federatedAt" IS NULL;
--
-- That WHERE clause looks like a description of history — "scheduled posts from
-- before these markers existed" — but it is a description of the PRESENT. It is
-- the exact state of every scheduled post that is mid-delivery right now
-- (src/lib/publish-post.ts claims a post by setting `published` alone, then
-- writes `federatedAt` only after federation and both crossposts have finished),
-- and it is character-for-character the predicate the retry sweep uses to
-- recover stranded posts. So re-running it marked live posts delivered when they
-- weren't AND removed them from the only mechanism that would ever have retried
-- them — silently, and permanently.
--
-- Inside the guard none of that is possible: the column does not exist, so no
-- row can carry a genuine marker, and this file runs before `db push` and before
-- `node server.js`, so nothing is mid-delivery. The backfill is unconditionally
-- correct there, and can never fire a second time on the same database.
--
-- A fixed date bound was considered and rejected: an install that has been
-- offline since before this date publishes its whole overdue backlog on first
-- boot, and those posts carry `publishedAt` values from BEFORE the bound. Crash
-- mid-backlog and the bug survives its own fix, in precisely the scenario the
-- backfill exists for.
--
-- See prisma/manual-migrations/README.md.

ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "threadsPostId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name   = 'Post'
       AND column_name  = 'federatedAt'
  ) THEN
    ALTER TABLE "Post" ADD COLUMN "federatedAt" TIMESTAMP(3);

    -- One-shot, at column-creation time only. Scheduled posts published before
    -- these markers existed already delivered; without this they would all look
    -- "claimed but never federated" and the retry sweep would re-send them once
    -- — and the pre-marker scheduler never persisted blueskyUri, so that retry
    -- would duplicate the Bluesky crosspost.
    UPDATE "Post"
       SET "federatedAt" = "publishedAt"
     WHERE "published" = true
       AND "scheduledFor" IS NOT NULL;

    RAISE NOTICE 'post-delivery-markers: federatedAt created and backfilled for pre-existing scheduled posts';
  END IF;
END $$;
