import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin } from "@/lib/auth";

interface NotificationItem {
  id: string;
  type: "like" | "boost" | "reply" | "follow" | "comment" | "dm";
  source: string; // "fedi", "bluesky", "guest"
  actor: string; // display name or handle
  actorUrl: string | null; // link to their fedi profile
  avatarUrl: string | null;
  summary: string; // e.g. "liked your post"
  targetUrl: string | null; // link to the post/photo on your site
  createdAt: string;
}

export async function POST(req: NextRequest) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Mark all as read — set cookie with current timestamp
  const res = NextResponse.json({ success: true });
  res.cookies.set("sl_notif_read", new Date().toISOString(), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    path: "/",
  });
  return res;
}

export async function GET(req: NextRequest) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ count: 0, items: [] });
  }

  const items: NotificationItem[] = [];
  const readAtStr = req.cookies.get("sl_notif_read")?.value;
  const readAt = readAtStr ? new Date(readAtStr) : null;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // 1. Pending guest comments
  const pendingComments = await prisma.guestComment.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      post: { select: { slug: true, title: true } },
      photo: { select: { slug: true, title: true } },
    },
  });

  for (const c of pendingComments) {
    const target = c.post
      ? { name: c.post.title || c.post.slug, url: `/post/${c.post.slug}` }
      : c.photo
        ? { name: c.photo.title || c.photo.slug, url: `/photography/${c.photo.slug}` }
        : { name: "unknown", url: null };

    items.push({
      id: `comment-${c.id}`,
      type: "comment",
      source: "guest",
      actor: c.guestName,
      actorUrl: null,
      avatarUrl: null,
      summary: `commented on "${target.name}"`,
      targetUrl: target.url,
      createdAt: c.createdAt.toISOString(),
    });
  }

  // 2. Recent fedi interactions on OUR content (last 24h)
  // First get all our post/photo AP IDs
  const ourPosts = await prisma.post.findMany({
    where: { apId: { not: null } },
    select: { apId: true, slug: true, title: true },
  });
  const ourPhotos = await prisma.photo.findMany({
    where: { apId: { not: null } },
    select: { apId: true, slug: true, title: true },
  });
  const apIdToUrl = new Map<string, { url: string; name: string }>();
  const ourApIds: string[] = [];
  for (const p of ourPosts) {
    if (p.apId) {
      apIdToUrl.set(p.apId, { url: `/post/${p.slug}`, name: p.title || p.slug });
      ourApIds.push(p.apId);
    }
  }
  for (const p of ourPhotos) {
    if (p.apId) {
      apIdToUrl.set(p.apId, { url: `/photography/${p.slug}`, name: p.title || p.slug });
      ourApIds.push(p.apId);
    }
  }

  // Only get interactions targeting OUR content
  const interactions = await prisma.fediInteraction.findMany({
    where: {
      createdAt: { gte: oneDayAgo },
      targetApId: { in: ourApIds },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  for (const i of interactions) {
    const target = apIdToUrl.get(i.targetApId);
    const verb = i.type === "like" ? "liked" : i.type === "boost" ? "boosted" : "replied to";

    items.push({
      id: `interaction-${i.id}`,
      type: i.type as "like" | "boost" | "reply",
      source: "fedi",
      actor: i.displayName || `@${i.username}@${i.domain}`,
      actorUrl: i.actorUri,
      avatarUrl: i.avatarUrl,
      summary: `${verb} "${target?.name || "your post"}"`,
      targetUrl: target?.url || null,
      createdAt: i.createdAt.toISOString(),
    });
  }

  // 3. Recent new followers (last 24h)
  const newFollowers = await prisma.fediFollower.findMany({
    where: { createdAt: { gte: oneDayAgo } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  for (const f of newFollowers) {
    items.push({
      id: `follow-${f.id}`,
      type: "follow",
      source: "fedi",
      actor: f.displayName || `@${f.username}@${f.domain}`,
      actorUrl: f.actorUri,
      avatarUrl: f.avatarUrl,
      summary: "followed you",
      targetUrl: f.actorUri,
      createdAt: f.createdAt.toISOString(),
    });
  }

  // 4. Unread DMs
  const allDMs = await prisma.directMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const convos = new Map<string, typeof allDMs>();
  for (const dm of allDMs) {
    const existing = convos.get(dm.conversationKey) || [];
    existing.push(dm);
    convos.set(dm.conversationKey, existing);
  }

  for (const messages of convos.values()) {
    const sorted = messages.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    if (sorted[0] && !sorted[0].isOutgoing) {
      items.push({
        id: `dm-${sorted[0].id}`,
        type: "dm",
        source: sorted[0].source,
        actor: sorted[0].senderName || sorted[0].senderHandle,
        actorUrl: sorted[0].source === "fedi" ? sorted[0].senderUri : null,
        avatarUrl: sorted[0].senderAvatar,
        summary: `sent you a message`,
        targetUrl: "/timeline",
        createdAt: sorted[0].createdAt.toISOString(),
      });
    }
  }

  // Sort all items by date
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Count only unread (newer than readAt)
  const unreadCount = readAt
    ? items.filter((i) => new Date(i.createdAt) > readAt).length
    : items.length;

  return NextResponse.json({ count: unreadCount, items: items.slice(0, 20) });
}
