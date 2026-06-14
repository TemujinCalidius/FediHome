import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { processAttachments, fetchLinkEmbed } from "@/lib/fedi-media";
import { verifyAdmin } from "@/lib/auth";
import { signedGet } from "@/lib/http-signatures";
import { sanitizeHtml } from "@/lib/sanitize";
import { assertPublicHost } from "@/lib/url-guard";

const MAX_DEPTH = 20;

export async function GET(req: NextRequest) {
  // Admin-only
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const postId = req.nextUrl.searchParams.get("postId");
  if (!postId) {
    return NextResponse.json({ error: "postId required" }, { status: 400 });
  }

  const startPost = await prisma.fediPost.findUnique({ where: { id: postId } });
  if (!startPost) {
    return NextResponse.json({ error: "post not found" }, { status: 404 });
  }

  // Walk up the reply chain to find the root
  const ancestors: typeof startPost[] = [];
  let currentApId = startPost.inReplyTo;
  let depth = 0;

  while (currentApId && depth < MAX_DEPTH) {
    // Check local DB first
    let parent = await prisma.fediPost.findUnique({
      where: { apId: currentApId },
    });

    if (!parent) {
      // Try fetching from remote
      parent = await fetchRemoteNote(currentApId);
    }

    if (!parent) break;

    ancestors.unshift(parent); // prepend — oldest first
    currentApId = parent.inReplyTo;
    depth++;
  }

  // Find all local replies to posts in this thread
  const threadApIds = [
    ...ancestors.map((p) => p.apId),
    startPost.apId,
  ];

  const replies = await prisma.fediPost.findMany({
    where: { inReplyTo: { in: threadApIds } },
    orderBy: { publishedAt: "asc" },
  });

  // Also find replies to those replies (one more level)
  const replyApIds = replies.map((r) => r.apId);
  const deepReplies = replyApIds.length > 0
    ? await prisma.fediPost.findMany({
        where: { inReplyTo: { in: replyApIds } },
        orderBy: { publishedAt: "asc" },
      })
    : [];

  // Build ordered thread: ancestors → startPost → replies → deepReplies
  // Deduplicate by apId
  const seen = new Set<string>();
  const thread = [];
  for (const post of [...ancestors, startPost, ...replies, ...deepReplies]) {
    if (!seen.has(post.apId)) {
      seen.add(post.apId);
      thread.push(post);
    }
  }

  // Serialize dates
  const serialized = thread.map((p) => ({
    ...p,
    publishedAt: p.publishedAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
  }));

  return NextResponse.json({ thread: serialized });
}

/**
 * Fetch a remote AP object and store it locally as a FediPost.
 */
async function fetchRemoteNote(apId: string) {
  try {
    // Signed GET — most servers run authorized-fetch and 401 unsigned requests,
    // which is why "View thread" on a reply to someone else loaded no ancestors.
    if (!(await assertPublicHost(apId))) return null;
    const res = await signedGet(apId, 6000);
    if (!res.ok) return null;

    const note = await res.json();
    if (note.type !== "Note" && note.type !== "Article") return null;

    // Fetch actor info
    const actorUri = note.attributedTo as string;
    if (!actorUri || !(await assertPublicHost(actorUri))) return null;

    const actorRes = await signedGet(actorUri, 6000);
    if (!actorRes.ok) return null;
    const actor = await actorRes.json();
    const domain = new URL(actorUri).hostname;

    const { urls: mediaUrls, types: mediaTypes } = await processAttachments(
      note.attachment
    );
    const embed = await fetchLinkEmbed(note.content || "");

    const inReplyTo = (note.inReplyTo as string) || null;
    const conversationId =
      note.conversation || note.context || inReplyTo || note.id || null;
    const safeHtml = sanitizeHtml(note.content || "");

    return prisma.fediPost.upsert({
      where: { apId: note.id },
      create: {
        actorUri,
        apId: note.id,
        content: note.content || "",
        contentHtml: safeHtml,
        mediaUrls,
        mediaTypes,
        inReplyTo,
        conversationId,
        embedUrl: embed?.url || null,
        embedTitle: embed?.title || null,
        embedDescription: embed?.description || null,
        embedImage: embed?.image || null,
        embedSiteName: embed?.siteName || null,
        username: actor.preferredUsername || "unknown",
        domain,
        displayName: actor.name || null,
        avatarUrl: actor.icon?.url || null,
        publishedAt: note.published ? new Date(note.published) : new Date(),
      },
      update: {},
    });
  } catch {
    return null;
  }
}
