import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { BskyAgent } from "@atproto/api";
import { verifyAdmin } from "@/lib/auth";

/**
 * Poll Bluesky for replies to crossposted posts.
 * GET /api/bluesky-replies — fetches replies for all posts with a blueskyUri.
 * Can also be called with ?postId=xxx to fetch for a single post.
 *
 * Protected by admin cookie or a simple API secret for cron use.
 */
export async function GET(req: NextRequest) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) {
    return NextResponse.json({ error: "Bluesky not configured" }, { status: 500 });
  }

  // Login to Bluesky
  const agent = new BskyAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: handle, password });

  // Get posts to poll
  const postId = req.nextUrl.searchParams.get("postId");
  const posts = postId
    ? await prisma.post.findMany({ where: { id: postId, blueskyUri: { not: null } } })
    : await prisma.post.findMany({
        where: { blueskyUri: { not: null } },
        orderBy: { publishedAt: "desc" },
        take: 20, // only poll recent posts
      });

  let totalNew = 0;

  for (const post of posts) {
    if (!post.blueskyUri) continue;

    try {
      // Parse the AT URI to get the thread
      const threadRes = await agent.getPostThread({ uri: post.blueskyUri, depth: 10 });

      if (!threadRes.success || threadRes.data.thread.$type !== "app.bsky.feed.defs#threadViewPost") {
        continue;
      }

      const thread = threadRes.data.thread as {
        replies?: Array<{
          $type: string;
          post?: {
            uri: string;
            author: {
              did: string;
              handle: string;
              displayName?: string;
              avatar?: string;
            };
            record: {
              text: string;
              createdAt: string;
            };
          };
          replies?: unknown[];
        }>;
      };

      if (!thread.replies) continue;

      // Process replies recursively
      const newReplies = await processReplies(thread.replies, post.id);
      totalNew += newReplies;
    } catch (err) {
      console.error(`Failed to fetch Bluesky thread for ${post.slug}:`, err);
    }
  }

  return NextResponse.json({ success: true, postsPolled: posts.length, newReplies: totalNew });
}

async function processReplies(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replies: any[],
  postId: string
): Promise<number> {
  let count = 0;

  for (const reply of replies) {
    if (reply.$type !== "app.bsky.feed.defs#threadViewPost" || !reply.post) continue;

    const { post: replyPost } = reply;
    const uri = replyPost.uri;
    const author = replyPost.author;
    const record = replyPost.record;

    if (!uri || !record?.text) continue;

    // Upsert to avoid duplicates
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
    } catch {
      // Skip duplicates or errors
    }

    // Process nested replies
    if (reply.replies && Array.isArray(reply.replies)) {
      count += await processReplies(reply.replies, postId);
    }
  }

  return count;
}
