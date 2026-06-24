import { prisma } from "./db";
import { htmlToText } from "./html-text";

export interface NotificationItem {
  id: string;
  type: "like" | "boost" | "reply" | "follow" | "comment" | "dm" | "update";
  source: string;
  actor: string;
  actorUrl: string | null;
  avatarUrl: string | null;
  summary: string;
  targetUrl: string | null;
  maintenanceId: string | null;
  createdAt: string;
}

export interface NotificationResult {
  count: number;
  items: NotificationItem[];
  categoryCounts: Record<string, number>;
}

/**
 * Build the owner's notification list + unread totals. The single source of
 * truth for both the bell (`GET /api/notifications`) and the push badge count
 * (`sendPushToOwner`), so the Dock/home-screen badge tracks the bell rather than
 * blind-incrementing per push. (#103)
 */
export async function computeNotifications(): Promise<NotificationResult> {
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
      maintenanceId: null,
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
    const snippet = htmlToText(r.content, 50);
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
      maintenanceId: null,
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
      maintenanceId: null,
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
        maintenanceId: null,
        createdAt: sorted[0].createdAt.toISOString(),
      });
    }
  }

  // 5. Maintenance items (package updates, security advisories, release notes)
  const maintenanceItems = await prisma.maintenanceItem.findMany({
    where: { dismissed: false, applied: false },
    orderBy: { createdAt: "desc" },
  });

  for (const m of maintenanceItems) {
    let summary: string;
    if (m.kind === "update") {
      summary = `${m.packageName} ${m.current ?? ""} → ${m.latest ?? ""}`.trim();
    } else if (m.kind === "security") {
      summary = `${(m.severity || "moderate").toUpperCase()} advisory in ${m.packageName}`;
    } else {
      summary = `${m.packageName} ${m.latest ?? ""} released`;
    }

    items.push({
      id: `maintenance-${m.id}`,
      type: "update",
      source: "maintenance",
      actor: m.kind === "security" ? "Security advisory" : m.kind === "release-note" ? "New release" : "Package update",
      actorUrl: null,
      avatarUrl: null,
      summary: m.title || summary,
      targetUrl: m.url,
      maintenanceId: m.id,
      createdAt: m.createdAt.toISOString(),
    });
  }

  // 6. Bluesky interactions on OUR content — likes, reposts, mentions, quotes,
  // follows ingested by syncBlueskyNotifications (#134). Replies are section 7.
  const ourBskyPosts = await prisma.post.findMany({
    where: { blueskyUri: { not: null } },
    select: { blueskyUri: true, slug: true, title: true },
  });
  const bskyUriToPost = new Map<string, { url: string; name: string }>();
  for (const p of ourBskyPosts) {
    if (p.blueskyUri) bskyUriToPost.set(p.blueskyUri, { url: `/post/${p.slug}`, name: p.title || p.slug });
  }

  const bskyInteractions = await prisma.blueskyInteraction.findMany({
    orderBy: { createdAt: "desc" },
  });

  for (const i of bskyInteractions) {
    const target = i.subjectUri ? bskyUriToPost.get(i.subjectUri) : null;
    const handleUrl = `https://bsky.app/profile/${i.authorHandle}`;
    const bskyPostUrl = i.postUri
      ? `https://bsky.app/profile/${i.authorHandle}/post/${i.postUri.split("/").pop()}`
      : null;
    // Map onto the bell's closed type union: repost→boost, mention/quote→reply.
    const type: NotificationItem["type"] =
      i.type === "repost" ? "boost" : i.type === "mention" || i.type === "quote" ? "reply" : i.type === "like" ? "like" : "follow";

    let summary: string;
    let targetUrl: string;
    if (i.type === "like") { summary = `liked "${target?.name ?? "your post"}"`; targetUrl = target?.url ?? handleUrl; }
    else if (i.type === "repost") { summary = `reposted "${target?.name ?? "your post"}"`; targetUrl = target?.url ?? handleUrl; }
    else if (i.type === "quote") { summary = `quoted "${target?.name ?? "your post"}"`; targetUrl = target?.url ?? bskyPostUrl ?? handleUrl; }
    else if (i.type === "mention") { summary = "mentioned you in a post"; targetUrl = bskyPostUrl ?? handleUrl; }
    else { summary = "followed you"; targetUrl = handleUrl; }

    items.push({
      id: `bsky-${i.id}`,
      type,
      source: "bluesky",
      actor: i.displayName || i.authorHandle,
      actorUrl: handleUrl,
      avatarUrl: i.avatarUrl,
      summary,
      targetUrl,
      maintenanceId: null,
      createdAt: i.createdAt.toISOString(),
    });
  }

  // 7. Bluesky replies on OUR posts (recent, bounded — replies can be high
  // volume). Surfaces ingested replies in the bell, not just on the post page.
  const bskyReplies = await prisma.blueskyReply.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { post: { select: { slug: true, title: true } } },
  });

  for (const r of bskyReplies) {
    items.push({
      id: `bskyreply-${r.id}`,
      type: "reply",
      source: "bluesky",
      actor: r.displayName || r.authorHandle,
      actorUrl: `https://bsky.app/profile/${r.authorHandle}`,
      avatarUrl: r.avatarUrl,
      summary: `replied to "${r.post.title || r.post.slug}"`,
      targetUrl: `/post/${r.post.slug}`,
      maintenanceId: null,
      createdAt: r.createdAt.toISOString(),
    });
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

  return { count: totalUnread, items, categoryCounts };
}
