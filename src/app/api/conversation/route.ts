import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { processAttachments, fetchLinkEmbed } from "@/lib/fedi-media";
import { authenticateApiRequest } from "@/lib/auth";
import { signedGet } from "@/lib/http-signatures";
import { sanitizeHtml } from "@/lib/sanitize";
import { assertPublicHost } from "@/lib/url-guard";
import { blockedActorUris, blockedPostFilter, isBlockedSender } from "@/lib/blocks";
import { guardedFetch } from "@/lib/safe-fetch";

const MAX_DEPTH = 20;
const MAX_CONTEXT = 200; // cap on remote thread posts ingested per view
const FETCH_TIMEOUT_MS = 8000;

type FediPostRow = Awaited<ReturnType<typeof prisma.fediPost.findUnique>>;

export async function GET(req: NextRequest) {
  // Owner cookie OR a `read`-scoped bearer token (a native app). Read-only → no CSRF.
  if (!(await authenticateApiRequest(req, "read")).ok) {
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

  // Bluesky rows have no apId and no AP thread endpoint to walk (#393). The
  // conversation is already stored locally via conversationId, so serve that
  // rather than trying to federate a thread that doesn't exist.
  if (!startPost.apId) {
    const thread = startPost.conversationId
      ? await prisma.fediPost.findMany({
          where: { conversationId: startPost.conversationId, ...(await blockedPostFilter()) },
          orderBy: { publishedAt: "asc" },
        })
      : [startPost];
    return NextResponse.json({
      thread: thread.map((p) => ({
        ...p,
        publishedAt: p.publishedAt.toISOString(),
        createdAt: p.createdAt.toISOString(),
      })),
    });
  }
  const startApId = startPost.apId;

  // Boost rows carry a synthetic id — thread the ORIGINAL post.
  const sourceApId = startApId.startsWith("boost:")
    ? startApId.match(/^boost:.*:(https?:\/\/.*)$/)?.[1] || startApId
    : startApId;

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

    // Bluesky rows in the same reply chain have no apId; drop them from the
    // ancestor id list rather than passing nulls into an `in` clause.
    const threadApIds = [...ancestors.map((p) => p.apId), startApId].filter(
      (a): a is string => a !== null,
    );
    // The same filter the Bluesky branch above applies (#459). Without it, this
    // ActivityPub path returned a blocked actor's replies while the Bluesky path
    // hid them — the same thread answering differently depending on which network
    // the post arrived from.
    const blockFilter = await blockedPostFilter();
    const replies = await prisma.fediPost.findMany({
      where: { inReplyTo: { in: threadApIds }, ...blockFilter },
      orderBy: { publishedAt: "asc" },
    });
    const replyApIds = replies.map((r) => r.apId).filter((a): a is string => a !== null);
    const deepReplies =
      replyApIds.length > 0
        ? await prisma.fediPost.findMany({
            where: { inReplyTo: { in: replyApIds }, ...blockFilter },
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
    // Keyed on id, not apId: Bluesky rows have no apId, and id is unique for both.
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
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
  // Before any network contact: a domain-blocked instance must not be asked for
  // a thread, the same reasoning follow() uses for its pre-WebFinger check.
  if (await isBlockedSender(apId)) return null;
  if (!(await assertPublicHost(ctxUrl))) return null;

  let ctx: { ancestors?: unknown; descendants?: unknown };
  try {
    const res = await guardedFetch(ctxUrl, {
      crossOrigin: true,
      label: "conversation context",
      timeoutMs: FETCH_TIMEOUT_MS,
      init: {
      headers: { Accept: "application/json" },
    },
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
  //
  // Sliced the SAME way as the ingest below, and no longer over the concatenation
  // (#460). It used to take the first MAX_CONTEXT of anc+desc while ingest took
  // MAX_CONTEXT of EACH, so a big thread ingested up to 2x what the map covered.
  // Every status past the end of the map failed its idToUri lookup and fell back
  // to `null` — landing as a TOP-LEVEL row rather than a reply, which is exactly
  // the row shape that reaches the public page.
  const all = [...(anc || []).slice(0, MAX_CONTEXT), ...(desc || []).slice(0, MAX_CONTEXT)];
  const idToUri = new Map<string, string>();
  for (const s of all) if (s?.id && s?.uri) idToUri.set(String(s.id), s.uri);
  // The queried status isn't in its own context — map it so direct replies link.
  idToUri.set(String(id), apId);

  // One batch check over the whole context before anything is written (#396).
  // This route had no block gate at all, so opening a thread re-imported posts
  // that block() had purged — and a re-imported thread ROOT is a top-level row,
  // so it came back in /timeline permanently, not just in the thread view.
  const contextActors = [...(anc || []), ...(desc || [])]
    .map((s) => s?.account?.uri)
    .filter((u): u is string => !!u);
  const blocked = await blockedActorUris(contextActors);

  const ingest = async (s: MastoStatus): Promise<NonNullable<FediPostRow> | null> => {
    if (!s?.uri || !s.account?.uri) return null;
    if (blocked.has(s.account.uri)) return null;
    const safe = sanitizeHtml(s.content || "");
    const media = (s.media_attachments || []).filter((m) => m?.url);
    const mediaUrls = media.map((m) => m.url!);
    // This path stores the remote URLs directly rather than proxying, so each
    // entry is already its own original (#478). Recorded anyway so the array
    // stays parallel — a trim that finds no local file here has nothing to undo.
    const mediaRemoteUrls = mediaUrls;
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
          mediaRemoteUrls,
          inReplyTo,
          conversationId: null,
          username: s.account.username || "unknown",
          domain,
          displayName: s.account.display_name || null,
          avatarUrl: s.account.avatar || null,
          publishedAt: s.created_at ? new Date(s.created_at) : new Date(),
          // Thread expansion, not the owner's feed (#460).
          viaLookup: true,
        },
        // Deliberately not in `update`: a row already here from delivery keeps
        // its feed provenance rather than being demoted by someone opening it.
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
    //
    // The block check comes FIRST, before the request rather than before the
    // write (#396): a signed GET to a blocked host is exactly the outbound
    // contact #379 was opened to stop, and the note's own id is enough to
    // decide the domain half.
    if (await isBlockedSender(apId)) return null;
    if (!(await assertPublicHost(apId))) return null;
    const res = await signedGet(apId, 6000);
    if (!res.ok) return null;

    const note = await res.json();
    if (note.type !== "Note" && note.type !== "Article") return null;

    // Fetch actor info
    const actorUri = note.attributedTo as string;
    if (!actorUri || !(await assertPublicHost(actorUri))) return null;
    // The note's host and its author's host can differ, so re-check on the
    // author before fetching their profile and before the upsert below.
    if (await isBlockedSender(actorUri)) return null;

    const actorRes = await signedGet(actorUri, 6000);
    if (!actorRes.ok) return null;
    const actor = await actorRes.json();
    const domain = new URL(actorUri).hostname;

    const { urls: mediaUrls, types: mediaTypes, remotes: mediaRemoteUrls } = await processAttachments(
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
        mediaRemoteUrls,
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
        // Ancestor walk — same on-demand fetch as the Mastodon path (#460).
        viaLookup: true,
      },
      update: {},
    });
  } catch {
    return null;
  }
}
