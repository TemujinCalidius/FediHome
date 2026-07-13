import { prisma } from "./db";
import { getEffectiveSchedulerConfig } from "./scheduler-config";
import { removeFediMediaFiles } from "./fedi-media";

/**
 * Prune stale cached REMOTE federated posts (#240). Remote posts (isOutgoing
 * false) are disposable — re-fetchable from origin — yet otherwise grow the DB
 * (and on-disk media) unbounded. Gated by the scheduler's `retentionSweep` job
 * (default OFF), this deletes remote posts older than the configured window and
 * reclaims their cached media.
 *
 * The keep set (NEVER pruned) is deliberately narrow:
 *  - our own posts/replies (`isOutgoing: true`);
 *  - remote posts in a thread WE participated in — anything whose apId is a
 *    parent we replied to, or whose conversationId groups a thread we're in
 *    (incl. threads rooted at our own posts) — so our replies keep their context;
 *  - `FediInteraction` / `FediFollower` / `FediFollowing` / `DirectMessage` are
 *    untouched here (every FediInteraction is already an interaction on OUR
 *    content, and the rest are relationships/DMs — none is remote cache).
 *
 * The clock is `createdAt` (when WE cached it), never `publishedAt`: a
 * freshly-ingested boost of an old post must age from ingestion, not from the
 * original post date. Rows are deleted BEFORE their files are unlinked — an
 * orphaned file is harmless (the storage evictor reclaims it) but a row that
 * points at a deleted file would render a broken image.
 */

const BATCH = 200;
// Bound a single tick's work so a huge first-run backlog can't monopolise the
// event loop; the remainder drains on subsequent ticks.
const MAX_BATCHES_PER_TICK = 20;

export interface RetentionSummary {
  scanned: number;
  pruned: number;
  filesRemoved: number;
  capped: boolean;
}

export async function pruneStaleFediPosts(now: Date = new Date()): Promise<RetentionSummary> {
  const days = (await getEffectiveSchedulerConfig()).retentionSweep.retentionDays;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60_000);

  // Build the keep set from our own posts: the remote parents we replied to
  // (spare by apId) and the threads we're part of (spare by conversationId,
  // including threads rooted at our own posts' apIds).
  const owned = await prisma.fediPost.findMany({
    where: { isOutgoing: true },
    select: { apId: true, inReplyTo: true, conversationId: true },
  });
  const keepApIds = new Set<string>();
  const keepConvIds = new Set<string>();
  for (const p of owned) {
    if (p.inReplyTo) keepApIds.add(p.inReplyTo);
    if (p.conversationId) keepConvIds.add(p.conversationId);
    if (p.apId) keepConvIds.add(p.apId);
  }

  let scanned = 0;
  let pruned = 0;
  let filesRemoved = 0;
  let capped = false;

  for (let i = 0; ; i++) {
    if (i >= MAX_BATCHES_PER_TICK) {
      capped = true;
      break;
    }
    const batch = await prisma.fediPost.findMany({
      where: {
        isOutgoing: false,
        createdAt: { lt: cutoff },
        ...(keepApIds.size > 0 ? { apId: { notIn: [...keepApIds] } } : {}),
        // notIn skips NULLs in SQL, so OR back the null-conversation rows —
        // else remote posts with no thread would never be prunable.
        ...(keepConvIds.size > 0
          ? { OR: [{ conversationId: null }, { conversationId: { notIn: [...keepConvIds] } }] }
          : {}),
      },
      select: { id: true, mediaUrls: true, embedImage: true },
      take: BATCH,
    });
    if (batch.length === 0) break;
    scanned += batch.length;

    const ids = batch.map((p) => p.id);
    const del = await prisma.fediPost.deleteMany({ where: { id: { in: ids } } });
    pruned += del.count;

    const media = batch.flatMap(
      (p) => [...(p.mediaUrls ?? []), p.embedImage].filter(Boolean) as string[],
    );
    filesRemoved += await removeFediMediaFiles(media);

    if (batch.length < BATCH) break;
  }

  return { scanned, pruned, filesRemoved, capped };
}
