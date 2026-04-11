import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin } from "@/lib/auth";

interface NotificationItem {
  id: string;
  type: "like" | "boost" | "reply" | "follow" | "comment" | "dm";
  source: string;
  actor: string;
  actorUrl: string | null;
  avatarUrl: string | null;
  summary: string;
  targetUrl: string | null;
  createdAt: string;
}

export async function POST(req: NextRequest) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Mark all as read — store timestamp in DB so it syncs across devices
  await prisma.siteSetting.upsert({
    where: { key: "notif_read_at" },
    update: { value: new Date().toISOString() },
    create: { key: "notif_read_at", value: new Date().toISOString() },
  });

  return NextResponse.json({ success: true });
}

export async function GET(req: NextRequest) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ count: 0, items: [], categoryCounts: {} });
  }

  const items: NotificationItem[] = [];

  // Get read-at timestamp from DB (syncs across devices)
  const readAtSetting = await prisma.siteSetting.findUnique({
    where: { key: "notif_read_at" },
  });
  const readAt = readAtSetting ? new Date(readAtSetting.value) : null;

  // 1. Pending guest comments (no limit)
  const pendingComments = await prisma.guestComment.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
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

  // 2. Fedi interactions on OUR content (no limit)
  const ourPosts = await prisma.post.findMany({
    where: { apId: { not: null } },
    select: { apId: true, slug: true, title: true },
  });
  const ourPhotos = await prisma.photo.findMany({
    where: { apId: { not: null } },
    select: { apId: true, slug: true, title: true },
  });
  const ourReplies = await prisma.fediPost.findMany({
    where: { isOutgoing: true },
    select: { apId: true, content: true },
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
  for (const r of ourReplies) {
    const snippet = r.content.replace(/<[^>]*>/g, "").slice(0, 50) + (r.content.length > 50 ? "..." : "");
    apIdToUrl.set(r.apId, { url: "/timeline", name: snippet });
    ourApIds.push(r.apId);
  }

  const interactions = await prisma.fediInteraction.findMany({
    where: { targetApId: { in: ourApIds } },
    orderBy: { createdAt: "desc" },
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

  // 3. Followers (no limit)
  const allFollowers = await prisma.fediFollower.findMany({
    orderBy: { createdAt: "desc" },
  });

  for (const f of allFollowers) {
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

  // 4. Unread DMs (no limit)
  const allDMs = await prisma.directMessage.findMany({
    orderBy: { createdAt: "desc" },
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

  // Count unread per category
  const categoryCounts: Record<string, number> = {};
  let totalUnread = 0;
  for (const item of items) {
    const isUnread = !readAt || new Date(item.createdAt) > readAt;
    if (isUnread) {
      categoryCounts[item.type] = (categoryCounts[item.type] || 0) + 1;
      totalUnread++;
    }
  }

  return NextResponse.json({ count: totalUnread, items, categoryCounts });
}
