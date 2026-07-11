import { prisma } from "./db";
import { log } from "./log";
import { siteConfig } from "@/../site.config";

/**
 * Delete one of our own Posts, federating the removal (#16). Used by both the
 * Micropub and XML-RPC delete paths so they behave identically.
 *
 * Two things the old naive `prisma.post.delete(...).catch(() => {})` got wrong:
 *  1. It never told followers, so remote servers (Mastodon, etc.) kept a cached
 *     copy forever. We now emit an ActivityPub `Delete` to followers.
 *  2. It silently failed for a post that had child rows — `BlueskyReply.postId`
 *     is a REQUIRED foreign key (the delete would hit an FK constraint), and
 *     `GuestComment.postId` is optional (the rows would be orphaned). We clear
 *     both first, in one transaction with the post delete.
 *
 * Follow-up posts in a thread (our own posts whose `inReplyToPostId` points at
 * this one) are intentionally NOT deleted — that self-relation is optional, so
 * Postgres nulls their `inReplyToPostId` and they survive as standalone posts.
 * Deleting one post shouldn't wipe the rest of the thread you wrote.
 */
export async function deletePostWithFederation(post: {
  id: string;
  apId: string | null;
  published: boolean;
}): Promise<void> {
  // Remove the post + its child rows atomically. Also drop any queued crosspost
  // retry (#225) so a pending retry can't publish the just-deleted content to
  // Bluesky/Threads after the fact (the retry job also guards on the post being
  // gone, but clearing the row here removes it immediately).
  await prisma.$transaction([
    prisma.blueskyReply.deleteMany({ where: { postId: post.id } }),
    prisma.guestComment.deleteMany({ where: { postId: post.id } }),
    prisma.failedCrosspost.deleteMany({ where: { postId: post.id } }),
    prisma.post.delete({ where: { id: post.id } }),
  ]);

  // Then federate the removal so remote servers drop their cached copy. Only for
  // published posts that were actually federated; best-effort — AP delivery is
  // retried out of band and a delivery hiccup must not fail the delete.
  if (post.published && post.apId) {
    const siteUrl = siteConfig.url;
    const activity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${siteUrl}/ap/delete/${post.id}`,
      type: "Delete",
      actor: `${siteUrl}/ap/actor`,
      object: post.apId,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${siteUrl}/ap/followers`],
    };
    const { deliverToFollowers } = await import("./http-signatures");
    deliverToFollowers(activity).catch((err) =>
      log.error("failed to federate post Delete", { err, postId: post.id }),
    );
  }
}
