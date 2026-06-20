import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { processAttachments, fetchLinkEmbed } from "@/lib/fedi-media";
import { verifyAdmin } from "@/lib/auth";
import { signedGet } from "@/lib/http-signatures";
import { sanitizeHtml } from "@/lib/sanitize";
import { assertPublicHost } from "@/lib/url-guard";

const MAX_DEPTH = 20;
const MAX_CONTEXT = 200; // cap on remote thread posts ingested per view
const FETCH_TIMEOUT_MS = 8000;

type FediPostRow = Awaited<ReturnType<typeof prisma.fediPost.findUnique>>;

export async function GET(req: NextRequest) {
  // Admin-only
  if (!(await verifyAdmin(req))) {
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

  // Boost rows carry a synthetic id — thread the ORIGINAL post.
  const sourceApId = startPost.apId.startsWith("boost:")
    ? startPost.apId.match(/^boost:.*:(https?:\/\/.*)$/)?.[1] || startPost.apId
    : startPost.apId;

  // PREFERRED: pull the whole conversation (everyone's replies) from the origin
  // instance's Mastodon-API context endpoint, ingesting each post locally.
  const ctx = await fetchThreadViaMastodon(sourceApId);

  let ordered: NonNullable<FediPostRow>[];
  if (ctx) {
    ordered = dedupe([...ctx.ancestors, startPost, ...ctx.descendants]);
  } else {
    // FALLBACK (non-Mastodon servers): signed-AP ancestor walk + local replies.
    const ancestors: NonNullable<FediPostRow>[] = [];
    let currentApId = startPost.inReplyTo;
    let depth = 0;
    while (currentApId && depth < MAX_DEPTH) {
      let parent: FediPostRow = await prisma.fediPost.findUnique({ where: { apId: currentApId } });
      if (!parent) parent = await fetchRemoteNote(currentApId);
      if (!parent) break;
      ancestors.unshift(parent);
      currentApId = parent.inReplyTo;
      depth++;
    }

    const threadApIds = [...ancestors.map((p) => p.apId), startPost.apId];
    const replies = await prisma.fediPost.findMany({
      where: { inReplyTo: { in: threadApIds } },
      orderBy: { publishedAt: "asc" },
    });
    const replyApIds = replies.map((r) => r.apId);
    const deepReplies =
      replyApIds.length > 0
        ? await prisma.fediPost.findMany({
            where: { inReplyTo: { in: replyApIds } },
            orderBy: { publishedAt: "asc" },
          })
        : [];
    ordered = dedupe([...ancestors, startPost, ...replies, ...deepReplies]);
  }

  const serialized = ordered.map((p) => ({
    ...p,
    publishedAt: p.publishedAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
  }));

  return NextResponse.json({ thread: serialized });
}

function dedupe(posts: NonNullable<FediPostRow>[]): NonNullable<FediPostRow>[] {
  const seen = new Set<string>();
  const out: NonNullable<FediPostRow>[] = [];
  for (const p of posts) {
    if (p && !seen.has(p.apId)) {
      seen.add(p.apId);
      out.push(p);
    }
  }
  return out;
}

/**
 * Fetch a full conversation from the origin instance's Mastodon-API context
 * endpoint (`/api/v1/statuses/:id/context` → { ancestors, descendants }) and
 * ingest every post as a FediPost so the thread shows EVERYONE's replies, not
 * just ones we already had locally. Public endpoint (no auth). Returns null when
 * it isn't a Mastodon-API server / status, so the caller can fall back.
 */
async function fetchThreadViaMastodon(
  apId: string
): Promise<{ ancestors: NonNullable<FediPostRow>[]; descendants: NonNullable<FediPostRow>[] } | null> {
  let u: URL;
  try {
    u = new URL(apId);
  } catch {
    return null;
  }
  const id = u.pathname.split("/").filter(Boolean).pop();
  if (!id) return null;
  const ctxUrl = `${u.origin}/api/v1/statuses/${encodeURIComponent(id)}/context`;
  if (!(await assertPublicHost(ctxUrl))) return null;

  let ctx: { ancestors?: unknown; descendants?: unknown };
  try {
    const res = await fetch(ctxUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    ctx = await res.json();
  } catch {
    return null;
  }
  const anc = Array.isArray(ctx.ancestors) ? (ctx.ancestors as MastoStatus[]) : null;
  const desc = Array.isArray(ctx.descendants) ? (ctx.descendants as MastoStatus[]) : null;
  if (!anc && !desc) return null;

  // Map each status's local id → AP uri so we can thread replies correctly.
  const all = [...(anc || []), ...(desc || [])].slice(0, MAX_CONTEXT);
  const idToUri = new Map<string, string>();
  for (const s of all) if (s?.id && s?.uri) idToUri.set(String(s.id), s.uri);
  // The queried status isn't in its own context — map it so direct replies link.
  idToUri.set(String(id), apId);

  const ingest = async (s: MastoStatus): Promise<NonNullable<FediPostRow> | null> => {
    if (!s?.uri || !s.account?.uri) return null;
    const safe = sanitizeHtml(s.content || "");
    const media = (s.media_attachments || []).filter((m) => m?.url);
    const mediaUrls = media.map((m) => m.url!);
    const mediaTypes = media.map((m) => (m.type === "image" ? "image" : "video"));
    const inReplyTo = s.in_reply_to_id ? idToUri.get(String(s.in_reply_to_id)) || null : null;
    let domain = "";
    try {
      domain = new URL(s.account.uri).hostname;
    } catch {
      domain = s.account.acct?.split("@")[1] || "";
    }
    try {
      return await prisma.fediPost.upsert({
        where: { apId: s.uri },
        create: {
          actorUri: s.account.uri,
          apId: s.uri,
          content: s.content || "",
          contentHtml: safe,
          mediaUrls,
          mediaTypes,
          inReplyTo,
          conversationId: null,
          username: s.account.username || "unknown",
          domain,
          displayName: s.account.display_name || null,
          avatarUrl: s.account.avatar || null,
          publishedAt: s.created_at ? new Date(s.created_at) : new Date(),
        },
        update: { contentHtml: safe, inReplyTo, avatarUrl: s.account.avatar || null },
      });
    } catch {
      return null;
    }
  };

  const ancestors = (await Promise.all((anc || []).slice(0, MAX_CONTEXT).map(ingest))).filter(
    (p): p is NonNullable<FediPostRow> => !!p
  );
  const descendants = (await Promise.all((desc || []).slice(0, MAX_CONTEXT).map(ingest))).filter(
    (p): p is NonNullable<FediPostRow> => !!p
  );
  return { ancestors, descendants };
}

interface MastoStatus {
  id?: string;
  uri?: string;
  content?: string;
  created_at?: string;
  in_reply_to_id?: string | null;
  media_attachments?: { type?: string; url?: string }[];
  account?: { uri?: string; acct?: string; username?: string; display_name?: string; avatar?: string };
}

/**
 * Fetch a single remote AP note (signed) and store it locally. Used for the
 * non-Mastodon ancestor-walk fallback.
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
