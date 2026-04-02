import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverActivity, verifyIncomingSignature } from "@/lib/http-signatures";
import { processAttachments, fetchLinkEmbed } from "@/lib/fedi-media";
import { sanitizeHtml } from "@/lib/sanitize";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";

export async function POST(req: NextRequest) {
  // Verify HTTP signature — reject unsigned/invalid requests
  const sigHeader = req.headers.get("signature");
  if (sigHeader) {
    const valid = await verifyIncomingSignature(req);
    if (!valid) {
      console.warn("AP inbox: rejected invalid HTTP signature");
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  let activity;
  try {
    activity = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const type = activity.type;
  const actorUri = typeof activity.actor === "string" ? activity.actor : activity.actor?.id;

  // Log all incoming activities for debugging
  console.log(`AP inbox: ${type} from ${actorUri}`);

  if (!actorUri) {
    return NextResponse.json({ error: "missing actor" }, { status: 400 });
  }

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
  try {
    const res = await fetch(actorUri, {
      headers: { Accept: "application/activity+json" },
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

  // If the booster is someone we follow, store the boosted post for our feed
  const isFollowed = await prisma.fediFollowing.findUnique({ where: { actorUri } });
  if (!isFollowed) return;

  // Check if we already have this boost stored
  const boostApId = `boost:${actorUri}:${targetApId}`;
  const existing = await prisma.fediPost.findUnique({ where: { apId: boostApId } });
  if (existing) return;

  // Fetch the original post from the remote server
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
    await prisma.directMessage.upsert({
      where: { apId: (note.id as string) || `dm-${Date.now()}` },
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
      }
    }
  } else if (inReplyTo) {
    // Not followed — only store if replying to our content (posts, photos, or our replies)
    const isOurContent =
      (await prisma.post.findFirst({ where: { apId: inReplyTo } })) ||
      (await prisma.photo.findFirst({ where: { apId: inReplyTo } })) ||
      (await prisma.fediPost.findFirst({ where: { apId: inReplyTo, isOutgoing: true } }));
    if (!isOurContent) return;
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
  }
}
