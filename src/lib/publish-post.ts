import type { Post } from "@/generated/prisma/client";
import { prisma } from "./db";
import { buildPostObject } from "./ap-post";
import { deliverToFollowers } from "./http-signatures";
import { crosspostToBluesky, crosspostToThreads } from "./crosspost";

const DEBUG = process.env.FEDIHOME_DEBUG === "true";

// A claimed scheduled post with no completed delivery is retried only after
// this grace period of NO row activity (anchored to `updatedAt`, which the
// claim itself bumps — anchoring to scheduledFor would make a post claimed
// late, e.g. after downtime over its slot, retry-eligible instantly). Delivery
// normally takes seconds; 10 minutes is comfortably past it.
const RETRY_GRACE_MS = 10 * 60_000;

/**
 * Publish an already-persisted Post: federate a `Create` to followers and
 * crosspost to Bluesky + Threads. Extracted from the Micropub route so BOTH the
 * immediate-create paths AND the scheduler (#183) publish identically. Takes a
 * Post row (no Next req/res), so it's callable from a standalone script.
 *
 * Best-effort AND retry-safe (#195): each side is caught so one failure can't
 * block the others. Federation is idempotent on retry (the activity id is
 * stable, remote servers dedupe); the crossposts are NOT, so each is guarded by
 * its persisted marker (blueskyUri / threadsPostId) — written here on success,
 * which also gives scheduled posts working Bluesky reply-sync (the immediate
 * compose path already persisted blueskyUri; the scheduler path didn't).
 */
export async function publishPost(post: Post): Promise<void> {
  const siteUrl = process.env.SITE_URL || "http://localhost:3000";

  // Federate the post via ActivityPub.
  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteUrl}/ap/create/${post.id}`,
    type: "Create",
    actor: `${siteUrl}/ap/actor`,
    published: post.publishedAt.toISOString(),
    object: buildPostObject(post),
  };
  await deliverToFollowers(activity).catch((err) =>
    console.error("Failed to federate post:", err)
  );

  // Cross-post to Bluesky + Threads, skipping any side that already succeeded.
  // The markers are RE-READ here rather than trusted from the caller's row
  // snapshot — federation above can take minutes, and a concurrent retry may
  // have crossposted since the snapshot was taken. (In-process overlap is
  // prevented by the scheduler's in-flight tick guard; this shrinks the
  // remaining cross-process window to milliseconds.)
  const fresh = await prisma.post
    .findUnique({ where: { id: post.id }, select: { blueskyUri: true, threadsPostId: true } })
    .catch(() => null);
  const markers = fresh ?? { blueskyUri: post.blueskyUri, threadsPostId: post.threadsPostId };

  const postUrl = `${siteUrl}/post/${post.slug}`;
  if (!markers.blueskyUri) {
    await crosspostToBluesky(post.content, postUrl)
      .then(async (r) => {
        if (r.success && r.uri) {
          if (DEBUG) console.log("Cross-posted to Bluesky:", r.uri);
          await prisma.post
            .update({ where: { id: post.id }, data: { blueskyUri: r.uri } })
            .catch((err) => console.error(`failed to store blueskyUri for ${post.slug}:`, err));
        } else if (!r.success) {
          console.error("Bluesky crosspost failed:", r.error);
        }
      })
      .catch((err) => console.error("Bluesky crosspost error:", err));
  }
  if (!markers.threadsPostId) {
    await crosspostToThreads(post.content, postUrl)
      .then(async (r) => {
        if (r.success && r.id) {
          if (DEBUG) console.log("Cross-posted to Threads:", r.id);
          await prisma.post
            .update({ where: { id: post.id }, data: { threadsPostId: r.id } })
            .catch((err) => console.error(`failed to store threadsPostId for ${post.slug}:`, err));
        } else if (!r.success) {
          console.error("Threads crosspost failed:", r.error);
        }
      })
      .catch((err) => console.error("Threads crosspost error:", err));
  }
}

/** Flip the gallery rows created for a scheduled compose post live. */
async function publishGalleryRows(post: Post): Promise<void> {
  await Promise.all([
    prisma.photo.updateMany({ where: { slug: { startsWith: `${post.slug}-photo-` }, published: false }, data: { published: true } }),
    prisma.video.updateMany({ where: { slug: { startsWith: `${post.slug}-video-` }, published: false }, data: { published: true } }),
    prisma.audio.updateMany({ where: { slug: { startsWith: `${post.slug}-audio-` }, published: false }, data: { published: true } }),
  ]).catch((err) => console.error(`failed to publish gallery rows for ${post.slug}:`, err));
}

/**
 * Publish every post whose scheduled time has passed (#183). Called by the
 * scheduler. Each post is claimed atomically (only the run that flips
 * published false→true proceeds), so overlapping runs can't double-federate.
 * Also flips any gallery rows (Photo/Video/Audio) created for a scheduled compose
 * post, keyed by the `<slug>-photo|video|audio-N` naming. Returns the count published.
 *
 * Second sweep (#195): a crash between the claim and delivery used to leave a
 * post published-but-unfederated forever. Delivery completion is now recorded
 * in `federatedAt`; claimed scheduled posts still missing it after a grace
 * period get ONE retry, itself atomically claimed (by setting federatedAt), so
 * concurrent instances can't retry twice. Federation redelivery is deduped
 * remotely; crossposts are marker-guarded — worst case is a skipped retry,
 * never a double-post.
 */
export async function publishDueScheduledPosts(now: Date = new Date()): Promise<number> {
  const due = await prisma.post.findMany({
    where: { published: false, scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: 50,
  });

  let published = 0;
  for (const post of due) {
    const claim = await prisma.post.updateMany({
      where: { id: post.id, published: false },
      data: { published: true },
    });
    if (claim.count !== 1) continue; // another run already took it

    await publishGalleryRows(post);
    await publishPost(post);
    await prisma.post
      .updateMany({ where: { id: post.id }, data: { federatedAt: new Date() } })
      .catch((err) => console.error(`failed to mark federatedAt for ${post.slug}:`, err));
    published++;
  }

  // Retry sweep: claimed but never-delivered scheduled posts (#195). The grace
  // is anchored to updatedAt (last row touch — the claim bumps it), NOT
  // scheduledFor, so a post claimed late after downtime still gets its full
  // quiet period before a retry can fire.
  const grace = new Date(now.getTime() - RETRY_GRACE_MS);
  const stuck = await prisma.post.findMany({
    where: { published: true, federatedAt: null, scheduledFor: { not: null }, updatedAt: { lte: grace } },
    orderBy: { scheduledFor: "asc" },
    take: 20,
  });
  for (const post of stuck) {
    const claim = await prisma.post.updateMany({
      where: { id: post.id, federatedAt: null },
      data: { federatedAt: new Date() },
    });
    if (claim.count !== 1) continue; // another instance is retrying it

    console.log(`retrying delivery for scheduled post ${post.slug} (claimed but never federated)`);
    await publishGalleryRows(post); // the crash may have skipped these too
    await publishPost(post);
    published++;
  }

  return published;
}
