import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverActivity, verifyIncomingSignature, actorMatchesSigner } from "@/lib/http-signatures";
import { processAttachments, fetchLinkEmbed } from "@/lib/fedi-media";
import { sanitizeHtml } from "@/lib/sanitize";
import { assertPublicHost } from "@/lib/url-guard";
import { sendPushToOwner } from "@/lib/push";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";
const ACTOR_FETCH_TIMEOUT_MS = 8000;

/** Friendly display label for a fedi actor, e.g. "Ada" or "@ada@mastodon.social". */
function actorLabel(info: { displayName?: string | null; username: string; domain: string }): string {
  return info.displayName || `@${info.username}@${info.domain}`;
}

/** Push body for a reply: "<actor>: <plain-text snippet>". */
function replyPushBody(
  info: { displayName?: string | null; username: string; domain: string },
  html: string
): string {
  const text = html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const snippet = text.length > 120 ? text.slice(0, 117) + "…" : text;
  return snippet ? `${actorLabel(info)}: ${snippet}` : `${actorLabel(info)} replied to you`;
}

export async function POST(req: NextRequest) {
  // Read body as text first so we can validate Digest against the actual bytes
  // and reject before parsing (C4).
  const rawBody = await req.text();

  const verification = await verifyIncomingSignature(req, rawBody);
  if (!verification.valid) {
    console.warn(`AP inbox: rejected signature (${verification.reason})`);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let activity;
  try {
    activity = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const type = activity.type;
  const actorUri = typeof activity.actor === "string" ? activity.actor : activity.actor?.id;

  if (!actorUri) {
    return NextResponse.json({ error: "missing actor" }, { status: 400 });
  }

  // C5: bind the verified keyId-derived actor to the claimed activity actor.
  // Otherwise any signer can post follows/likes/boosts attributed to anyone.
  if (!actorMatchesSigner(verification.actorUri, actorUri)) {
    console.warn(
      `AP inbox: keyId/actor mismatch (signer=${verification.actorUri} claimed=${actorUri})`
    );
    return NextResponse.json({ error: "keyId/actor mismatch" }, { status: 401 });
  }

  // L1: encode actorUri before logging to prevent log-injection via newlines
  console.log(`AP inbox: ${type} from ${encodeURIComponent(actorUri)}`);

  switch (type) {
    case "Follow":
      await handleFollow(actorUri, activity);
      break;

    case "Undo":
      if (activity.object?.type === "Follow") {
        await handleUnfollow(actorUri);
      } else if (activity.object?.type === "Like") {
        await handleUndoLike(actorUri, activity.object);
      }
      break;

    case "Like":
      await handleLike(actorUri, activity);
      break;

    case "Announce": // Boost
      await handleBoost(actorUri, activity);
      break;

    case "Create":
      if (activity.object?.type === "Note") {
        await handleNote(actorUri, activity.object);
      }
      break;

    case "Delete":
      // Handle deletes silently
      break;

    case "Accept":
      // Our follow request was accepted
      break;

    default:
      console.log(`Unhandled ActivityPub activity type: ${type}`);
  }

  return new NextResponse(null, { status: 202 });
}

async function fetchActorInfo(actorUri: string) {
  if (!(await assertPublicHost(actorUri))) return null;
  try {
    const res = await fetch(actorUri, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(ACTOR_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const actor = await res.json();
    const domain = new URL(actorUri).hostname;
    return {
      username: actor.preferredUsername || "unknown",
      domain,
      displayName: actor.name || null,
      avatarUrl: actor.icon?.url || null,
      inbox: actor.inbox,
    };
  } catch {
    return null;
  }
}

async function handleFollow(actorUri: string, activity: Record<string, unknown>) {
  const info = await fetchActorInfo(actorUri);
  if (!info) return;

  // Only a genuinely new follow should buzz the phone (Follow can be redelivered).
  const alreadyFollowing = await prisma.fediFollower.findUnique({ where: { actorUri } });

  // Store follower
  await prisma.fediFollower.upsert({
    where: { actorUri },
    create: {
      actorUri,
      inbox: info.inbox,
      username: info.username,
      domain: info.domain,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
    },
    update: {
      inbox: info.inbox,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
    },
  });

  if (!alreadyFollowing) {
    void sendPushToOwner({
      title: "New follower",
      body: `${actorLabel(info)} followed you`,
      url: "/timeline",
      type: "follow",
      icon: info.avatarUrl || undefined,
    }).catch(() => {});
  }

  // Auto-accept: send signed Accept activity back
  try {
    await deliverActivity(info.inbox, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${siteUrl}/ap/accept/${Date.now()}`,
      type: "Accept",
      actor: `${siteUrl}/ap/actor`,
      object: activity,
    });
  } catch (err) {
    console.error("Failed to send Accept:", err);
  }
}

async function handleUnfollow(actorUri: string) {
  await prisma.fediFollower.delete({ where: { actorUri } }).catch(() => {});
}

async function handleLike(actorUri: string, activity: Record<string, unknown>) {
  const targetApId = typeof activity.object === "string"
    ? activity.object
    : (activity.object as Record<string, unknown>)?.id as string;

  if (!targetApId) return;

  const info = await fetchActorInfo(actorUri);
  if (!info) return;

  await prisma.fediInteraction.create({
    data: {
      type: "like",
      actorUri,
      targetApId,
      username: info.username,
      domain: info.domain,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
    },
  });

  // Increment like count on post/photo
  await prisma.post.updateMany({
    where: { apId: targetApId },
    data: { likeCount: { increment: 1 } },
  });
  await prisma.photo.updateMany({
    where: { apId: targetApId },
    data: { likeCount: { increment: 1 } },
  });

  void sendPushToOwner({
    title: "New like",
    body: `${actorLabel(info)} liked your post`,
    url: "/timeline",
    type: "like",
    icon: info.avatarUrl || undefined,
  }).catch(() => {});
}

async function handleUndoLike(actorUri: string, likeActivity: Record<string, unknown>) {
  const targetApId = typeof likeActivity.object === "string"
    ? likeActivity.object
    : (likeActivity.object as Record<string, unknown>)?.id as string;

  if (!targetApId) return;

  const deleted = await prisma.fediInteraction.deleteMany({
    where: { actorUri, targetApId, type: "like" },
  });

  if (deleted.count > 0) {
    await prisma.post.updateMany({
      where: { apId: targetApId },
      data: { likeCount: { decrement: 1 } },
    });
    await prisma.photo.updateMany({
      where: { apId: targetApId },
      data: { likeCount: { decrement: 1 } },
    });
  }
}

async function handleBoost(actorUri: string, activity: Record<string, unknown>) {
  const targetApId = typeof activity.object === "string"
    ? activity.object
    : (activity.object as Record<string, unknown>)?.id as string;

  if (!targetApId) return;

  const info = await fetchActorInfo(actorUri);
  if (!info) return;

  // Record interaction and increment counters (existing behavior)
  await prisma.fediInteraction.create({
    data: {
      type: "boost",
      actorUri,
      targetApId,
      username: info.username,
      domain: info.domain,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
    },
  });

  await prisma.post.updateMany({
    where: { apId: targetApId },
    data: { boostCount: { increment: 1 } },
  });
  await prisma.photo.updateMany({
    where: { apId: targetApId },
    data: { boostCount: { increment: 1 } },
  });

  void sendPushToOwner({
    title: "New boost",
    body: `${actorLabel(info)} boosted your post`,
    url: "/timeline",
    type: "boost",
    icon: info.avatarUrl || undefined,
  }).catch(() => {});

  // If the booster is someone we follow, store the boosted post for our feed
  const isFollowed = await prisma.fediFollowing.findUnique({ where: { actorUri } });
  if (!isFollowed) return;

  // Check if we already have this boost stored
  const boostApId = `boost:${actorUri}:${targetApId}`;
  const existing = await prisma.fediPost.findUnique({ where: { apId: boostApId } });
  if (existing) return;

  // Fetch the original post from the remote server
  if (!(await assertPublicHost(targetApId))) return;
  try {
    const res = await fetch(targetApId, {
      headers: { Accept: "application/activity+json, application/ld+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const note = await res.json();
    if (note.type !== "Note") return;

    const originalActorUri = typeof note.attributedTo === "string"
      ? note.attributedTo
      : note.attributedTo?.id;
    const originalInfo = originalActorUri ? await fetchActorInfo(originalActorUri) : null;

    const content = sanitizeHtml((note.content as string) || "");
    const { urls: mediaUrls, types: mediaTypes } = await processAttachments(
      note.attachment as unknown[] | undefined
    );
    const embed = await fetchLinkEmbed(content);

    await prisma.fediPost.create({
      data: {
        actorUri: originalActorUri || actorUri,
        apId: boostApId,
        content,
        contentHtml: content,
        mediaUrls,
        mediaTypes,
        username: originalInfo?.username || "unknown",
        domain: originalInfo?.domain || new URL(targetApId).hostname,
        displayName: originalInfo?.displayName,
        avatarUrl: originalInfo?.avatarUrl,
        boostedBy: actorUri,
        boostedByName: info.displayName || `${info.username}@${info.domain}`,
        publishedAt: new Date(), // boost time, not original post time
        embedUrl: embed?.url || null,
        embedTitle: embed?.title || null,
        embedDescription: embed?.description || null,
        embedImage: embed?.image || null,
        embedSiteName: embed?.siteName || null,
      },
    });
  } catch {
    // Failed to fetch original post — skip silently
  }
}

async function handleNote(actorUri: string, note: Record<string, unknown>) {
  const inReplyTo = (note.inReplyTo as string) || null;

  const info = await fetchActorInfo(actorUri);
  if (!info) return;

  // Check if this is a DM (direct message to us, not public)
  const toList = Array.isArray(note.to) ? note.to as string[] : [note.to as string].filter(Boolean);
  const ccList = Array.isArray(note.cc) ? note.cc as string[] : [note.cc as string].filter(Boolean);
  const isPublic = [...toList, ...ccList].includes("https://www.w3.org/ns/activitystreams#Public");
  const isDirectToUs = toList.includes(`${siteUrl}/ap/actor`) && !isPublic;

  if (isDirectToUs) {
    // Store as a direct message
    const dmApId = (note.id as string) || `dm-${Date.now()}`;
    const dmExisted = await prisma.directMessage.findUnique({ where: { apId: dmApId } });
    await prisma.directMessage.upsert({
      where: { apId: dmApId },
      create: {
        source: "fedi",
        senderUri: actorUri,
        senderHandle: `@${info.username}@${info.domain}`,
        senderName: info.displayName,
        senderAvatar: info.avatarUrl,
        content: (note.content as string) || "",
        contentHtml: sanitizeHtml((note.content as string) || ""),
        apId: (note.id as string) || null,
        conversationKey: `fedi:${actorUri}`,
        createdAt: note.published ? new Date(note.published as string) : new Date(),
      },
      update: {},
    });
    console.log(`AP inbox: DM from ${info.username}@${info.domain}`);
    if (!dmExisted) {
      void sendPushToOwner({
        title: "New message",
        body: `${actorLabel(info)} sent you a message`,
        url: "/timeline",
        type: "dm",
        icon: info.avatarUrl || undefined,
      }).catch(() => {});
    }
    return;
  }

  // Check if this person is someone we follow
  const isFollowed = await prisma.fediFollowing.findUnique({
    where: { actorUri },
  });

  if (isFollowed) {
    // Store as FediPost for timeline (both top-level and replies from followed accounts)
    const { urls: mediaUrls, types: mediaTypes } = await processAttachments(
      note.attachment as unknown[] | undefined
    );

    const rawContent = (note.content as string) || "";
    const content = sanitizeHtml(rawContent);
    const embed = await fetchLinkEmbed(rawContent);
    const conversationId =
      (note.conversation as string) ||
      (note.context as string) ||
      inReplyTo ||
      (note.id as string) ||
      null;

    await prisma.fediPost.upsert({
      where: { apId: (note.id as string) || "" },
      create: {
        actorUri,
        apId: (note.id as string) || `unknown-${Date.now()}`,
        content,
        contentHtml: content,
        mediaUrls,
        mediaTypes,
        inReplyTo,
        conversationId,
        embedUrl: embed?.url || null,
        embedTitle: embed?.title || null,
        embedDescription: embed?.description || null,
        embedImage: embed?.image || null,
        embedSiteName: embed?.siteName || null,
        username: info.username,
        domain: info.domain,
        displayName: info.displayName,
        avatarUrl: info.avatarUrl,
        publishedAt: note.published
          ? new Date(note.published as string)
          : new Date(),
      },
      update: {},
    });

    // Also record as FediInteraction if replying to one of OUR posts or replies
    if (inReplyTo) {
      const isOurPost =
        (await prisma.post.findFirst({ where: { apId: inReplyTo } })) ||
        (await prisma.photo.findFirst({ where: { apId: inReplyTo } })) ||
        (await prisma.fediPost.findFirst({ where: { apId: inReplyTo, isOutgoing: true } }));
      if (isOurPost) {
        await prisma.fediInteraction.create({
          data: {
            type: "reply",
            actorUri,
            targetApId: inReplyTo,
            content: sanitizeHtml((note.content as string) || ""),
            username: info.username,
            domain: info.domain,
            displayName: info.displayName,
            avatarUrl: info.avatarUrl,
          },
        });
        void sendPushToOwner({
          title: "New reply",
          body: replyPushBody(info, content),
          url: "/timeline",
          type: "reply",
          icon: info.avatarUrl || undefined,
        }).catch(() => {});
      }
    }
  } else if (inReplyTo) {
    // Not followed — only store if replying to our content (posts, photos, or our replies)
    const isOurContent =
      (await prisma.post.findFirst({ where: { apId: inReplyTo } })) ||
      (await prisma.photo.findFirst({ where: { apId: inReplyTo } })) ||
      (await prisma.fediPost.findFirst({ where: { apId: inReplyTo, isOutgoing: true } }));
    if (!isOurContent) return;
    const replyHtml = sanitizeHtml((note.content as string) || "");
    await prisma.fediInteraction.create({
      data: {
        type: "reply",
        actorUri,
        targetApId: inReplyTo,
        content: replyHtml,
        username: info.username,
        domain: info.domain,
        displayName: info.displayName,
        avatarUrl: info.avatarUrl,
      },
    });
    void sendPushToOwner({
      title: "New reply",
      body: replyPushBody(info, replyHtml),
      url: "/timeline",
      type: "reply",
      icon: info.avatarUrl || undefined,
    }).catch(() => {});
  }
}
