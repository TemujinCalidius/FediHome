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

/**
 * Has the marker outlived the work it records (#516)?
 *
 * The marker says "the backfill ran". What actually matters is "the column is
 * populated", and those are the same fact right up until the column is dropped
 * and recreated — which is exactly what a rollback past #460 does. `prisma db
 * push` refuses to drop `viaLookup` on the data-loss guard and the container
 * crash-loops, so the way out is a manual `ALTER TABLE … DROP COLUMN`. Nothing
 * removes the SiteSetting row alongside it. Roll forward and the column comes
 * back `DEFAULT false` on every row while the marker still reads "done", so
 * every previously-hidden stray matches the public feed query again — the exact
 * outcome #460 exists to prevent, silently, with no signal that anything
 * happened.
 *
 * The marker already stores the COUNT, so no extra state is needed to tell the
 * two apart:
 *
 *  - recorded 0 → nothing was ever marked, so "nothing is marked now" is the
 *    expected state and says nothing. A rollback costs such an instance nothing
 *    either, since there was nothing to lose.
 *  - recorded N > 0 with nothing marked now → the column came back empty.
 *
 * **The #384 protection survives**, which is the thing to be careful about: the
 * predicate still runs at most once per POPULATED column, not once per boot.
 * One honest exception, worth stating rather than hiding — if the retention
 * sweep eventually prunes every marked row, this reads as stale and re-runs
 * once. That marks strays as hidden, which is the safe direction and the bias
 * the backfill already has, and it then settles: either the fresh count is
 * positive and rows exist, or it is 0 and this returns false from now on.
 */
async function markerOutlivedItsColumn(recorded: string): Promise<boolean> {
  const marked = Number(recorded);
  if (!Number.isFinite(marked) || marked <= 0) return false;
  const any = await prisma.fediPost.findFirst({
    where: { viaLookup: true },
    select: { id: true },
  });
  return any === null;
}

export async function backfillViaLookup(): Promise<number | null> {
  const done = await prisma.siteSetting.findUnique({ where: { key: BACKFILL_KEY } });
  if (done && !(await markerOutlivedItsColumn(done.value))) return null;

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
