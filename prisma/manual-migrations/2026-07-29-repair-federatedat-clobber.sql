-- Repair for #384. Additive + idempotent.
--
-- The old, ungated backfill in 2026-07-03-post-delivery-markers.sql ran on every
-- container start. Its predicate matched every scheduled post that was
-- mid-delivery or crash-stranded at that instant, so it wrote `federatedAt` over
-- posts that had NOT been delivered — and because that predicate is identical to
-- the retry sweep's, it also removed them from the only mechanism that would
-- have noticed. Those posts were never federated and nothing will ever retry
-- them.
--
-- Clearing `federatedAt` re-arms the sweep (src/lib/publish-post.ts), which
-- gives the post exactly one delivery attempt. That is safe:
--   * federation is deduped remotely — the Create id is stable (/ap/create/<id>);
--   * the Bluesky and Threads crossposts are guarded by blueskyUri /
--     threadsPostId, which publish-post.ts re-reads from the database
--     immediately before crossposting, so a copy that already went out is not
--     sent twice.
--
-- SAFE TO RE-RUN FOREVER: after it runs no row matches, and no code path can
-- create a matching row again. The only two writers of `federatedAt` in the app
-- both write now(), and the corrected 07-03 file now writes only at
-- column-creation time.
--
-- @dml-ok: self-extinguishing repair; the predicate is proved disjoint from both
-- live and legitimately-backfilled rows in the comments below.

UPDATE "Post" AS p
   SET "federatedAt" = NULL
 WHERE p."published" = true
   AND p."scheduledFor" IS NOT NULL

   -- (1) THE SIGNATURE, and the proof this cannot touch a live delivery.
   -- A genuine marker is ALWAYS strictly greater than publishedAt: for a
   -- scheduled post publishedAt = scheduledFor (both set from one Date at
   -- compose time), the sweep can only claim it once scheduledFor <= now on a
   -- 15s master tick / 60s job interval, and three awaited network round-trips
   -- follow before the marker is written. Only the old backfill ever wrote
   -- publishedAt into federatedAt.
   -- A post that is mid-delivery RIGHT NOW has federatedAt IS NULL, and
   -- `NULL = publishedAt` is UNKNOWN, which WHERE rejects. That holds for every
   -- row at every instant, with no timing assumption.
   AND p."federatedAt" = p."publishedAt"

   -- (2) Floor: the buggy file did not exist before this date. Belt and braces
   -- against a restored backup or a skewed clock; (3) already implies it.
   AND p."publishedAt" >= TIMESTAMP '2026-07-03 00:00:00'

   -- (3) Proof that THIS install was already writing markers from code before
   -- the post in question was published — so an equal-to-publishedAt marker on
   -- it can only have come from the migration.
   -- The witness must be a PROMPT marker (later than its own publishedAt, but by
   -- less than the retry grace period): only the due sweep writes those. A
   -- retry-sweep marker is always >= publishedAt + 10 minutes, because the retry
   -- requires updatedAt <= now - grace and the original claim bumped updatedAt
   -- to ~publishedAt. Without that upper bound, an old post that was legitimately
   -- retried would be an admissible witness and the clause would prove nothing.
   -- This is what keeps the legitimate pre-#195 backfill out: such a row was
   -- published BEFORE its install first ran marker-writing code, so no earlier
   -- prompt-marker witness can exist.
   -- Non-circular: a clobbered row has federatedAt = publishedAt, which fails the
   -- witness's `>`, so damaged rows can never vouch for each other.
   AND EXISTS (
     SELECT 1 FROM "Post" AS e
      WHERE e."publishedAt" <  p."publishedAt"
        AND e."federatedAt" >  e."publishedAt"
        AND e."federatedAt" <  e."publishedAt" + INTERVAL '10 minutes'
   );

-- KNOWN LIMITATION, deliberate: an install whose FIRST EVER scheduled post is the
-- clobbered one has no earlier witness and is not repaired. That is the price of
-- never touching a legitimate row — a missed repair leaves the status quo, while
-- a wrong one costs the owner a duplicate Bluesky post they must delete by hand
-- (pre-#195 posts never persisted blueskyUri, so nothing would guard the retry).
--
-- Note this deliberately does NOT touch `updatedAt`: retry eligibility stays
-- anchored to the post's last real activity, and the post is not falsely marked
-- as edited.

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM "Post"
   WHERE "published" = true AND "scheduledFor" IS NOT NULL AND "federatedAt" IS NULL;
  IF n > 0 THEN
    RAISE NOTICE 'repair-federatedat-clobber: % scheduled post(s) are awaiting delivery; the scheduler will send them shortly', n;
  END IF;
END $$;
