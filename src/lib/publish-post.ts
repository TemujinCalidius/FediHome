import type { Post } from "@/generated/prisma/client";
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
