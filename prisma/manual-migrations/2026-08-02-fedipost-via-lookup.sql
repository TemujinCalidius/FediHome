-- Manual migration for #460. Additive + idempotent.
--
-- Adds FediPost."viaLookup", which records HOW a row arrived:
--   false — the owner's own feed: delivered to the inbox, or synced from a
--           network they're connected to.
--   true  — fetched on demand because the owner LOOKED at something: expanded a
--           thread, or opened a stranger's profile.
--
-- Why it is needed: a thread ROOT has no in_reply_to, and nothing sets
-- boostedBy on it, so an ingested thread root matched the public feed's query
-- verbatim. Opening one thread out of curiosity published a stranger's post on
-- the operator's public page, under their domain, permanently. Browsing a remote
-- profile did the same thing with up to ten posts at a time.
--
-- Apply with:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/2026-08-02-fedipost-via-lookup.sql
-- Or (preferred, regenerates from schema.prisma):
--   npx prisma db push

ALTER TABLE "FediPost" ADD COLUMN IF NOT EXISTS "viaLookup" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Backfill. Existing rows carry no provenance, so it has to be inferred, and
-- the inference is deliberately biased: EVERY case it gets wrong hides a post
-- rather than exposing one. That is the correct bias for a page that renders to
-- strangers.
--
-- The rule is "not from someone the owner currently follows, and not the
-- owner's own". Known imprecision, accepted:
--   * someone followed and since UNFOLLOWED has their old posts hidden. The
--     page describes itself as the accounts the owner follows, present tense,
--     so this is arguably the right answer rather than a cost.
--   * a stranger who @-mentioned the owner in a top-level post is hidden. Also
--     right — a mention is not something the owner chose to publish.
--
-- Scoped to source = 'fedi' ON PURPOSE. Bluesky rows keep the author's DID in
-- actorUri while FediFollowing holds https actor URIs, so a NOT IN across both
-- matches every Bluesky row and would blank the Bluesky half of the feed.
--
-- The app ALSO runs this once at boot (src/lib/lookup-backfill.ts), gated on a
-- SiteSetting key, so an operator who upgrades with `prisma db push` gets it
-- without having to find this file. It is written to be safe either way: after
-- it runs no row matches, and it is not a standing rule — see #384 for what
-- happens when a backfill predicate is left to fire on every start.
-- ---------------------------------------------------------------------------

-- @dml-ok: gated on the same SiteSetting key the application uses, so the second
-- and every later run matches zero rows. That gate is not decoration. The
-- predicate below matches any post from someone not currently followed, and
-- ordinary use keeps producing those — a stranger @-mentions the owner and their
-- delivered post qualifies. Ungated, this would quietly promote itself from a
-- one-time backfill into a standing rule applied at every start, which is
-- precisely how #384 clobbered live data and disarmed the sweep that would have
-- caught it.

UPDATE "FediPost" SET "viaLookup" = true
WHERE "viaLookup" = false
  AND "source" = 'fedi'
  AND "isOutgoing" = false
  AND "boostedBy" IS NULL
  AND "actorUri" NOT IN (SELECT "actorUri" FROM "FediFollowing")
  AND NOT EXISTS (
    SELECT 1 FROM "SiteSetting" WHERE "key" = 'migrations.viaLookupBackfill'
  );

INSERT INTO "SiteSetting" ("key", "value", "updatedAt")
VALUES ('migrations.viaLookupBackfill', 'sql', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
