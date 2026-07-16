import { BskyAgent } from "@atproto/api";
import { getBlueskyCredentials } from "@/lib/integrations";
import { prisma } from "./db";
import { sendPushToOwner } from "./push";

/**
 * Ingest Bluesky interactions on our posts (likes, reposts, replies, mentions,
 * quotes, follows) from app.bsky.notification.listNotifications into the
 * notification bell + web-push — the receiver side the old per-post reply poll
 * never covered (#134).
 *
 * - Likes/reposts/mentions/quotes/follows → BlueskyInteraction (deduped by the
 *   notification's own at:// uri, since listNotifications is at-least-once).
 * - Replies → BlueskyReply (the existing model the post page already renders),
 *   so they additionally surface in the bell.
 *
 * Incremental + resumable via a `bsky_notif_last_seen` SiteSetting watermark
 * (newest indexedAt processed). The first run backfills history WITHOUT pushing
 * (gated by `bsky_notif_backfilled`) so we don't fire a notification storm.
 */

const SAFETY_PAGE_CAP = 50; // bound the first full backfill (50 × 100 = 5000)

type NewItem = {
  type: "like" | "repost" | "reply" | "mention" | "quote" | "follow";
  actor: string;
  url: string;
  icon?: string;
};

type BskyAuthor = { did: string; handle: string; displayName?: string | null; avatar?: string | null };
type BskyNotification = {
  uri: string;
  cid: string;
  author: BskyAuthor;
  reason: string;
  reasonSubject?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  record: any; // app.bsky.* record — shape varies by reason (parent.uri, subject.uri, text…)
  indexedAt: string;
};

type BlueskyInteractionInput = {
  type: string;
  notifUri: string;
  notifCid: string;
  authorDid: string;
  authorHandle: string;
  displayName: string | null;
  avatarUrl: string | null;
  subjectUri: string | null;
  postUri: string | null;
  content: string | null;
  reason: string;
  createdAt: Date;
};

export async function syncBlueskyNotifications(): Promise<{
  likes: number;
  reposts: number;
  replies: number;
  mentions: number;
  quotes: number;
  follows: number;
  pushed: number;
}> {
  const counts = { likes: 0, reposts: 0, replies: 0, mentions: 0, quotes: 0, follows: 0, pushed: 0 };

  const creds = await getBlueskyCredentials();
  if (!creds) return counts;
  const { handle, password } = creds;

  const agent = new BskyAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: handle, password });

  // Map our crossposted posts' at:// URIs → where to link / label them. The
  // subject of a like/repost (and a reply's parent) is one of these.
  const ourPosts = await prisma.post.findMany({
    where: { blueskyUri: { not: null } },
    select: { id: true, slug: true, title: true, blueskyUri: true },
  });
  const ownSubject = new Map<string, { postId: string; slug: string; name: string }>();
  for (const p of ourPosts) {
    if (p.blueskyUri) ownSubject.set(p.blueskyUri, { postId: p.id, slug: p.slug, name: p.title || p.slug });
  }

  const [wm, backfilled] = await Promise.all([
    prisma.siteSetting.findUnique({ where: { key: "bsky_notif_last_seen" } }),
    prisma.siteSetting.findUnique({ where: { key: "bsky_notif_backfilled" } }),
  ]);
  const watermark = wm?.value ?? null;
  const isFirstRun = backfilled?.value !== "1";

  // Page newest-first, collecting everything strictly newer than the watermark.
  const collected: BskyNotification[] = []; // raw listNotifications items, dynamically shaped
  let newestIndexedAt: string | null = null;
  let cursor: string | undefined;
  let stop = false;
  let pages = 0;
  do {
    const res = await agent.listNotifications({ limit: 100, cursor });
    if (!res.success) break;
    for (const n of res.data.notifications) {
      if (!newestIndexedAt) newestIndexedAt = n.indexedAt; // first item is the newest
      if (watermark && n.indexedAt <= watermark) { stop = true; break; }
      collected.push(n as unknown as BskyNotification);
    }
    cursor = res.data.cursor;
    pages++;
  } while (cursor && !stop && pages < SAFETY_PAGE_CAP);

  const newItems: NewItem[] = [];

  // Process oldest → newest so createdAt ordering and "new" detection are stable.
  for (const n of collected.reverse()) {
    const author = n.author;
    if (!author?.did) continue;
    const record = n.record ?? {};
    // Guard validity, not just presence: a malformed record.createdAt yields an
    // Invalid Date, which throws `RangeError` at Prisma serialization and would
    // propagate out before the watermark upsert — permanently stalling ingestion
    // and re-fetching the poison notification every run. Fall back to indexedAt,
    // then to now.
    let createdAt = record.createdAt ? new Date(record.createdAt) : new Date(n.indexedAt);
    if (isNaN(createdAt.getTime())) createdAt = new Date(n.indexedAt);
    if (isNaN(createdAt.getTime())) createdAt = new Date();
    const actorName: string = author.displayName || author.handle;

    switch (n.reason as string) {
      case "like":
      case "repost": {
        const subjectUri: string | undefined = n.reasonSubject ?? record.subject?.uri;
        if (!subjectUri) continue;
        const target = ownSubject.get(subjectUri);
        if (!target) continue; // not one of our posts
        const created = await createInteractionIfNew({
          type: n.reason, notifUri: n.uri, notifCid: n.cid,
          authorDid: author.did, authorHandle: author.handle,
          displayName: author.displayName || null, avatarUrl: author.avatar || null,
          subjectUri, postUri: null, content: null, reason: n.reason, createdAt,
        });
        if (created) {
          if (n.reason === "like") counts.likes++; else counts.reposts++;
          newItems.push({ type: n.reason as "like" | "repost", actor: actorName, url: `/post/${target.slug}`, icon: author.avatar || undefined });
        }
        break;
      }
      case "quote": {
        const subjectUri: string | undefined = n.reasonSubject;
        if (!subjectUri) continue;
        const target = ownSubject.get(subjectUri);
        if (!target) continue; // a quote of someone else's post — not ours
        const created = await createInteractionIfNew({
          type: "quote", notifUri: n.uri, notifCid: n.cid,
          authorDid: author.did, authorHandle: author.handle,
          displayName: author.displayName || null, avatarUrl: author.avatar || null,
          subjectUri, postUri: n.uri, content: record.text ?? null, reason: n.reason, createdAt,
        });
        if (created) {
          counts.quotes++;
          newItems.push({ type: "quote", actor: actorName, url: `/post/${target.slug}`, icon: author.avatar || undefined });
        }
        break;
      }
      case "mention": {
        // listNotifications only surfaces mentions of us — inherently ours.
        const created = await createInteractionIfNew({
          type: "mention", notifUri: n.uri, notifCid: n.cid,
          authorDid: author.did, authorHandle: author.handle,
          displayName: author.displayName || null, avatarUrl: author.avatar || null,
          subjectUri: null, postUri: n.uri, content: record.text ?? null, reason: n.reason, createdAt,
        });
        if (created) {
          counts.mentions++;
          newItems.push({ type: "mention", actor: actorName, url: "/timeline", icon: author.avatar || undefined });
        }
        break;
      }
      case "follow": {
        const created = await createInteractionIfNew({
          type: "follow", notifUri: n.uri, notifCid: n.cid,
          authorDid: author.did, authorHandle: author.handle,
          displayName: author.displayName || null, avatarUrl: author.avatar || null,
          subjectUri: null, postUri: null, content: null, reason: n.reason, createdAt,
        });
        if (created) {
          counts.follows++;
          newItems.push({ type: "follow", actor: actorName, url: "/timeline", icon: author.avatar || undefined });
        }
        break;
      }
      case "reply": {
        const parentUri: string | undefined = record.reply?.parent?.uri;
        if (!parentUri) continue;
        const target = ownSubject.get(parentUri);
        if (!target) continue; // a reply to someone else — not on our post
        const created = await createReplyIfNew(target.postId, n, record, author, createdAt);
        if (created) {
          counts.replies++;
          newItems.push({ type: "reply", actor: actorName, url: `/post/${target.slug}`, icon: author.avatar || undefined });
        }
        break;
      }
      default:
        continue; // starterpack-joined, verified, etc.
    }
  }

  // Advance the watermark + mark the first backfill complete.
  if (newestIndexedAt) {
    await prisma.siteSetting.upsert({
      where: { key: "bsky_notif_last_seen" },
      create: { key: "bsky_notif_last_seen", value: newestIndexedAt },
      update: { value: newestIndexedAt },
    });
  }
  if (isFirstRun) {
    await prisma.siteSetting.upsert({
      where: { key: "bsky_notif_backfilled" },
      create: { key: "bsky_notif_backfilled", value: "1" },
      update: { value: "1" },
    });
  }

  // Push: never on the first backfill (avoid a storm of historical interactions).
  // Otherwise push new items — but coalesce a burst into one summary so a popular
  // post doesn't buzz the owner N times.
  if (!isFirstRun && newItems.length > 0) {
    counts.pushed = await pushNewInteractions(newItems);
  }

  return counts;
}

async function createInteractionIfNew(data: BlueskyInteractionInput): Promise<boolean> {
  try {
    await prisma.blueskyInteraction.create({ data });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return false; // already ingested
    throw err;
  }
}

async function createReplyIfNew(
  postId: string,
  n: BskyNotification,
  record: BskyNotification["record"],
  author: BskyAuthor,
  createdAt: Date,
): Promise<boolean> {
  try {
    await prisma.blueskyReply.create({
      data: {
        postId,
        blueskyUri: n.uri,
        authorDid: author.did,
        authorHandle: author.handle,
        displayName: author.displayName || null,
        avatarUrl: author.avatar || null,
        content: record.text || "",
        createdAt,
      },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      // Already stored (e.g. by the post-page poll) — refresh the text, no push.
      await prisma.blueskyReply
        .update({
          where: { blueskyUri: n.uri },
          data: {
            content: record.text || "",
            displayName: author.displayName || null,
            avatarUrl: author.avatar || null,
          },
        })
        .catch(() => {});
      return false;
    }
    throw err;
  }
}

const PUSH_VERB: Record<NewItem["type"], { title: string; verb: string }> = {
  like: { title: "New like", verb: "liked your post" },
  repost: { title: "New repost", verb: "reposted your post" },
  reply: { title: "New reply", verb: "replied to your post" },
  mention: { title: "New mention", verb: "mentioned you" },
  quote: { title: "New quote", verb: "quoted your post" },
  follow: { title: "New follower", verb: "followed you" },
};

/** One push per new item when few; a single coalesced summary on a burst. */
async function pushNewInteractions(newItems: NewItem[]): Promise<number> {
  if (newItems.length <= 2) {
    for (const item of newItems) {
      const { title, verb } = PUSH_VERB[item.type];
      await sendPushToOwner({
        title: `${title} (Bluesky)`,
        body: `${item.actor} ${verb}`,
        url: item.url,
        type: item.type === "repost" ? "boost" : item.type === "mention" || item.type === "quote" ? "reply" : item.type,
        icon: item.icon,
        tag: "bsky-notif",
      }).catch(() => {});
    }
    return newItems.length;
  }
  await sendPushToOwner({
    title: "Bluesky",
    body: `${newItems.length} new Bluesky interactions`,
    url: "/timeline",
    type: "like",
    tag: "bsky-notif",
  }).catch(() => {});
  return newItems.length;
}
