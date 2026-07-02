import type { Post } from "@/generated/prisma/client";
import { prisma } from "./db";
import { buildPostObject } from "./ap-post";
import { deliverToFollowers } from "./http-signatures";
import { crosspostToBluesky, crosspostToThreads } from "./crosspost";

const DEBUG = process.env.FEDIHOME_DEBUG === "true";

/**
 * Publish an already-persisted Post: federate a `Create` to followers and
 * crosspost to Bluesky + Threads. Extracted from the Micropub route so BOTH the
 * immediate-create paths AND the scheduler (#183) publish identically. Takes a
 * Post row (no Next req/res), so it's callable from a standalone script.
 *
 * Best-effort: each side is caught so one failure can't block the others (or, in
 * the scheduler, the next post). Route callers should fire-and-forget (`void`);
 * the scheduler awaits it.
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

  // Cross-post to Bluesky + Threads.
  const postUrl = `${siteUrl}/post/${post.slug}`;
  await crosspostToBluesky(post.content, postUrl)
    .then((r) => {
      if (DEBUG && r.success) console.log("Cross-posted to Bluesky:", r.uri);
      else if (!r.success) console.error("Bluesky crosspost failed:", r.error);
    })
    .catch((err) => console.error("Bluesky crosspost error:", err));
  await crosspostToThreads(post.content, postUrl)
    .then((r) => {
      if (DEBUG && r.success) console.log("Cross-posted to Threads:", r.id);
      else if (!r.success) console.error("Threads crosspost failed:", r.error);
    })
    .catch((err) => console.error("Threads crosspost error:", err));
}

/**
 * Publish every post whose scheduled time has passed (#183). Called by the
 * scheduler. Each post is claimed atomically (only the run that flips
 * published false→true proceeds), so overlapping runs can't double-federate.
 * Also flips any gallery rows (Photo/Video/Audio) created for a scheduled compose
 * post, keyed by the `<slug>-photo|video|audio-N` naming. Returns the count published.
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

    await Promise.all([
      prisma.photo.updateMany({ where: { slug: { startsWith: `${post.slug}-photo-` }, published: false }, data: { published: true } }),
      prisma.video.updateMany({ where: { slug: { startsWith: `${post.slug}-video-` }, published: false }, data: { published: true } }),
      prisma.audio.updateMany({ where: { slug: { startsWith: `${post.slug}-audio-` }, published: false }, data: { published: true } }),
    ]).catch(() => {});

    await publishPost(post);
    published++;
  }
  return published;
}
