-- Let FediPost hold Bluesky posts as well as ActivityPub ones (#393).
-- Additive + idempotent.
--
-- Until now BlueskyFollowing was an address book: the social graph synced, but
-- nothing the people in it wrote was ever fetched. Imported Bluesky posts land
-- in FediPost alongside federated ones so the timeline reads both with no query
-- changes, and so the existing replies/boosts toggles keep working.
--
-- Note on `apId`: it becomes NULLABLE because Bluesky rows are identified by
-- `bskyUri` instead. It stays UNIQUE — Postgres permits many NULLs under a
-- unique index, so both columns remain safe to upsert on. Existing rows are
-- untouched and keep their apId.
--
-- The unique index is created HERE rather than left to `db push`, which refuses
-- to add a unique constraint without --accept-data-loss even on a brand-new
-- all-NULL column (#121/#123). Pre-creating it means the push that follows sees
-- no diff.

ALTER TABLE "FediPost"
  ADD COLUMN IF NOT EXISTS "source"  TEXT NOT NULL DEFAULT 'fedi',
  ADD COLUMN IF NOT EXISTS "bskyUri" TEXT;

ALTER TABLE "FediPost"
  ALTER COLUMN "apId" DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "FediPost_bskyUri_key" ON "FediPost" ("bskyUri");
CREATE INDEX IF NOT EXISTS "FediPost_source_idx" ON "FediPost" ("source");
