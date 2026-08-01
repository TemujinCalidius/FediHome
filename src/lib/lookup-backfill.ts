import { prisma } from "@/lib/db";

/**
 * One-shot backfill of FediPost.viaLookup (#460).
 *
 * The column records how a row arrived — delivered to the owner's feed, or
 * fetched on demand because they expanded a thread or opened a profile. Rows
 * written before the column existed carry no provenance, so it has to be
 * inferred once, and the inference is deliberately biased so that every case it
 * gets wrong HIDES a post rather than exposing one. That is the right bias for
 * a page that renders to strangers.
 *
 * Runs at boot rather than only as SQL because the documented upgrade path is
 * `prisma db push`, which syncs the schema and no data — so an operator who
 * upgrades normally would get the column and keep the strays.
 *
 * GATED ON A SETTING, AND THAT MATTERS. The predicate below matches any row
 * from someone not currently followed, which is a condition ordinary use keeps
 * producing: a stranger @-mentions the owner and their delivered post matches
 * it. Left ungated this would quietly promote itself from a backfill into a
 * standing rule applied at every start — the exact shape of #384, where a boot
 * backfill that re-ran forever clobbered live data and disarmed the sweep that
 * would have caught it. One run, recorded, never again.
 */
export const BACKFILL_KEY = "migrations.viaLookupBackfill";

export async function backfillViaLookup(): Promise<number | null> {
  const done = await prisma.siteSetting.findUnique({ where: { key: BACKFILL_KEY } });
  if (done) return null;

  const following = await prisma.fediFollowing.findMany({ select: { actorUri: true } });
  const followed = following.map((f) => f.actorUri);

  const { count } = await prisma.fediPost.updateMany({
    where: {
      viaLookup: false,
      // Bluesky rows keep the author's DID in actorUri while FediFollowing holds
      // https actor URIs, so an unscoped notIn matches every Bluesky row and
      // would blank the Bluesky half of the feed.
      source: "fedi",
      isOutgoing: false,
      boostedBy: null,
      actorUri: { notIn: followed },
    },
    data: { viaLookup: true },
  });

  // Written AFTER the update, so a crash mid-backfill retries rather than
  // recording a run that did not finish. Re-running is harmless — the predicate
  // is idempotent — whereas skipping it would leave strays on the public page.
  await prisma.siteSetting.upsert({
    where: { key: BACKFILL_KEY },
    create: { key: BACKFILL_KEY, value: String(count) },
    update: { value: String(count) },
  });

  if (count > 0) {
    console.log(`[fedihome] #460 backfill: ${count} post(s) marked as pulled-in-by-lookup`);
  }
  return count;
}
