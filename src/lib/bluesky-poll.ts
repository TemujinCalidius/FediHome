import { BskyAgent } from "@atproto/api";
import { prisma } from "./db";

// In-memory throttle so a post page doesn't re-poll Bluesky on every render.
// Keyed by postId; best-effort (resets on server restart), not durable state.
const POLL_TTL_MS = 60_000;
const POLL_TIMEOUT_MS = 15_000;
const lastPolledAt = new Map<string, number>();

// Bound a network call so a hung Bluesky request can't block the page render.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Poll Bluesky for replies, likes, and reposts on a specific post.
 * Called on page load for posts with a blueskyUri. Throttled by POLL_TTL_MS so
 * repeated renders within the window are skipped.
 */
export async function pollBlueskyReplies(postId: string, blueskyUri: string): Promise<number> {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) return 0;

  // Skip if this post was polled within the TTL window.
  const last = lastPolledAt.get(postId);
  if (last !== undefined && Date.now() - last < POLL_TTL_MS) return 0;
  lastPolledAt.set(postId, Date.now());

  const agent = new BskyAgent({ service: "https://bsky.social" });
  await withTimeout(agent.login({ identifier: handle, password }), POLL_TIMEOUT_MS, "Bluesky login");

  const threadRes = await withTimeout(
    agent.getPostThread({ uri: blueskyUri, depth: 10 }),
    POLL_TIMEOUT_MS,
    "Bluesky getPostThread",
  );
  if (!threadRes.success) return 0;

  const thread = threadRes.data.thread;
  if (thread.$type !== "app.bsky.feed.defs#threadViewPost") return 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const threadData = thread as any;

  // Update like and repost counts from the root post
  const rootPost = threadData.post;
  if (rootPost) {
    const bskyLikeCount = rootPost.likeCount ?? 0;
    const bskyRepostCount = rootPost.repostCount ?? 0;

    await prisma.post.update({
      where: { id: postId },
      data: { bskyLikeCount, bskyRepostCount },
    });
  }

  // Process replies
  const replies = threadData.replies;
  if (!replies || !Array.isArray(replies)) return 0;

  return processReplies(replies, postId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processReplies(replies: any[], postId: string): Promise<number> {
  let count = 0;

  for (const reply of replies) {
    if (reply.$type !== "app.bsky.feed.defs#threadViewPost" || !reply.post) continue;

    const { post: replyPost } = reply;
    const uri = replyPost.uri;
    const author = replyPost.author;
    const record = replyPost.record;

    if (!uri || !record?.text) continue;

    try {
      await prisma.blueskyReply.upsert({
        where: { blueskyUri: uri },
        create: {
          postId,
          blueskyUri: uri,
          authorDid: author.did,
          authorHandle: author.handle,
          displayName: author.displayName || null,
          avatarUrl: author.avatar || null,
          content: record.text,
          createdAt: new Date(record.createdAt),
        },
        update: {
          content: record.text,
          displayName: author.displayName || null,
          avatarUrl: author.avatar || null,
        },
      });
      count++;
    } catch (err) {
      console.warn(
        `Bluesky reply upsert failed for ${uri}:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (reply.replies && Array.isArray(reply.replies)) {
      count += await processReplies(reply.replies, postId);
    }
  }

  return count;
}
