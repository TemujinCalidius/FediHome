import { prisma } from "./db";
import {
  crosspostToBluesky,
  crosspostReplyToBluesky,
  crosspostToThreads,
  type CrosspostImage,
  type CrosspostVideo,
} from "./crosspost";

/**
 * Persisted retry for crossposts that fail transiently at compose time (#225).
 * The crosspost helpers return { success:false } (never throw) on a Bluesky/
 * Threads blip, and the compose path is fire-and-forget — so a hiccup used to
 * lose the crosspost forever. Failures are now enqueued here and retried by the
 * scheduler with backoff, mirroring the follower-delivery retry queue (#207).
 *
 * The stored `payload` is the exact crosspost arguments, re-sent verbatim, so a
 * retry reproduces the original attempt (no re-derivation drift). On success we
 * write the platform marker (blueskyUri / threadsPostId) on the Post and drop
 * the row; after MAX_ATTEMPTS we give up (terminal).
 *
 * DUPLICATE SAFETY: unlike the follower-delivery queue (#207), where remote AP
 * servers dedupe a redelivered activity by its stable id, Bluesky/Threads have
 * NO such dedupe — every retry is a fresh create call. Before re-posting we
 * therefore re-read the Post and SKIP if the platform's marker is already set
 * (a prior attempt landed but we crashed before deleting the row) or the Post
 * is gone (deleted since). The one residual we cannot cover: a
 * "landed-but-reported-false" original — the crosspost committed remotely but
 * the response was lost, so `success:false` was returned and no marker was
 * written — would be re-posted once, since neither platform offers a
 * client-side idempotency key. Accepted limitation.
 */

export type CrosspostPlatform = "bluesky" | "threads";

export interface CrosspostPayload {
  text: string;
  url?: string;
  images?: CrosspostImage[];
  video?: CrosspostVideo;
  replyTo?: string; // Bluesky reply-parent at:// URI, when the post is a reply
}

const FIRST_RETRY_DELAY_MS = 2 * 60_000;
const BACKOFF_MS = [2, 10, 60, 360, 1440].map((m) => m * 60_000); // 2m,10m,1h,6h,24h
const MAX_ATTEMPTS = 6; // 1 compose-time attempt + 5 retries, then give up
const CLAIM_LEASE_MS = 5 * 60_000;
const PRUNE_TERMINAL_AFTER_MS = 3 * 24 * 60 * 60_000; // drop terminal rows after 3d
const BATCH = 25;

/**
 * Record a failed crosspost for retry (#225). Best-effort + idempotent per
 * (postId, platform) — a repeat failure for the same post/platform bumps the
 * existing row rather than duplicating. Never throws.
 */
export async function enqueueFailedCrosspost(
  postId: string,
  platform: CrosspostPlatform,
  payload: CrosspostPayload,
  error: string | undefined
): Promise<void> {
  const nextRetryAt = new Date(Date.now() + FIRST_RETRY_DELAY_MS);
  await prisma.failedCrosspost
    .upsert({
      where: { postId_platform: { postId, platform } },
      create: { postId, platform, payload: JSON.stringify(payload), attempts: 1, nextRetryAt, lastError: (error || "").slice(0, 300) },
      update: { attempts: { increment: 1 }, lastError: (error || "").slice(0, 300) },
    })
    .catch((err) => console.error(`Failed to enqueue crosspost retry for ${postId}/${platform}:`, err));
}

/** Re-attempt one crosspost from its stored payload. Returns the platform marker on success. */
async function attempt(platform: string, payload: CrosspostPayload): Promise<{ ok: boolean; marker?: string; error?: string }> {
  if (platform === "bluesky") {
    const r = payload.replyTo
      ? await crosspostReplyToBluesky(payload.text, payload.replyTo, payload.url, payload.images, payload.video)
      : await crosspostToBluesky(payload.text, payload.url, payload.images, payload.video);
    return { ok: r.success, marker: r.uri, error: r.error };
  }
  if (platform === "threads") {
    const r = await crosspostToThreads(payload.text, payload.url);
    return { ok: r.success, marker: r.id, error: r.error };
  }
  return { ok: false, error: `unknown platform ${platform}` };
}

/** Persist the platform marker on the Post after a successful retry. */
async function writeMarker(postId: string, platform: string, marker: string | undefined): Promise<void> {
  if (!marker) return;
  const data = platform === "bluesky" ? { blueskyUri: marker } : platform === "threads" ? { threadsPostId: marker } : null;
  if (!data) return;
  await prisma.post.update({ where: { id: postId }, data }).catch((err) => console.error(`failed to store ${platform} marker for ${postId}:`, err));
}

export interface CrosspostRetrySummary {
  claimed: number;
  delivered: number;
  gaveUp: number;
  pruned: number;
}

export async function retryFailedCrossposts(now: Date = new Date()): Promise<CrosspostRetrySummary> {
  const due = await prisma.failedCrosspost.findMany({
    where: { failedAt: null, nextRetryAt: { lte: now } },
    orderBy: { nextRetryAt: "asc" },
    take: BATCH,
  });

  let claimed = 0;
  let delivered = 0;
  let gaveUp = 0;

  for (const row of due) {
    // Atomic claim: only the run that matches the current nextRetryAt wins.
    const claim = await prisma.failedCrosspost.updateMany({
      where: { id: row.id, nextRetryAt: row.nextRetryAt },
      data: { nextRetryAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (claim.count !== 1) continue;
    claimed++;

    // Duplicate guard (no remote dedupe for Bluesky/Threads): don't re-post if
    // this platform already has its marker (a prior attempt landed but the row
    // outlived it — e.g. a crash before deleteMany), or the Post is gone.
    const post = await prisma.post
      .findUnique({ where: { id: row.postId }, select: { blueskyUri: true, threadsPostId: true } })
      .catch(() => undefined);
    if (post === undefined) continue; // couldn't verify — leave the row (its lease holds) for next tick
    const alreadyDone =
      post === null ||
      (row.platform === "bluesky" && !!post.blueskyUri) ||
      (row.platform === "threads" && !!post.threadsPostId);
    if (alreadyDone) {
      await prisma.failedCrosspost.deleteMany({ where: { id: row.id } });
      continue;
    }

    let payload: CrosspostPayload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      await prisma.failedCrosspost.updateMany({ where: { id: row.id }, data: { failedAt: now, lastError: "unparseable payload" } });
      gaveUp++;
      continue;
    }

    const res = await attempt(row.platform, payload);
    if (res.ok) {
      await writeMarker(row.postId, row.platform, res.marker);
      await prisma.failedCrosspost.deleteMany({ where: { id: row.id } });
      delivered++;
      continue;
    }

    const attempts = row.attempts + 1;
    const lastError = (res.error || "unknown error").slice(0, 300);
    if (attempts >= MAX_ATTEMPTS) {
      await prisma.failedCrosspost.updateMany({ where: { id: row.id }, data: { attempts, failedAt: now, lastError } });
      gaveUp++;
    } else {
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
      await prisma.failedCrosspost.updateMany({ where: { id: row.id }, data: { attempts, nextRetryAt: new Date(now.getTime() + delay), lastError } });
    }
  }

  // Prune ONLY terminal rows (failedAt set), a few days after they gave up —
  // never a still-pending row, so a queue that sat while the job was off drains
  // on resume instead of being wiped (the #207 prune lesson).
  const pruned = await prisma.failedCrosspost
    .deleteMany({ where: { failedAt: { lt: new Date(now.getTime() - PRUNE_TERMINAL_AFTER_MS) } } })
    .then((r) => r.count)
    .catch(() => 0);

  return { claimed, delivered, gaveUp, pruned };
}
