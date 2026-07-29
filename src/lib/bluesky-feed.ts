import { getBlueskyAgent } from "./bluesky-agent";
import { isBlueskyBlocked } from "./blocks";
import { proxyImage } from "./fedi-media";
import { prisma } from "./db";
import { sanitizeHtml } from "./sanitize";

/**
 * Import posts from the people we follow on Bluesky (#393).
 *
 * `BlueskyFollowing` was an address book: the social graph synced, but nothing
 * the people in it wrote was ever fetched. A fediverse follow delivers posts to
 * our inbox and they land in the timeline; a Bluesky follow delivered a name and
 * a face with nothing behind it.
 *
 * Bluesky has no inbox push, so this polls. It uses **`getTimeline`** — the
 * server-side "Following" feed — rather than `getAuthorFeed` per account: one
 * call instead of N, already merged and ordered, and one cursor instead of one
 * per DID. That makes a single `SiteSetting` watermark sufficient.
 *
 * Posts land in `FediPost` with `source: "bluesky"`, so the timeline reads both
 * networks with no query changes and the existing replies/boosts toggles work on
 * them for free.
 */

const WATERMARK_KEY = "bsky_feed_last_seen";
const BACKFILLED_KEY = "bsky_feed_backfilled";

/** Pages of 100. A cap so a long gap can't turn into an unbounded crawl. */
const SAFETY_PAGE_CAP = 20;
/** First run only: keep the initial import to something sane. */
const FIRST_RUN_LIMIT = 50;
/** Bluesky allows four images per post. */
const MAX_IMAGES = 4;

export interface BlueskyFeedResult {
  fetched: number;
  imported: number;
  skippedBlocked: number;
}

interface FeedAuthor {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
}

/**
 * A Bluesky handle is `name.domain.tld`. The whole handle goes in `username` so
 * it renders as the person's actual address, and the registrable part in
 * `domain` so a domain block has something to match.
 */
export function domainOfHandle(handle: string): string {
  const parts = handle.split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : handle;
}

/**
 * Render a Bluesky post's PLAIN TEXT as safe HTML.
 *
 * **This is not optional.** The timeline renders `contentHtml || content`
 * through `dangerouslySetInnerHTML`, so storing a remote author's text with no
 * `contentHtml` would inject it as markup — anyone whose posts reach the
 * following feed could run script in the admin panel. Bluesky records are plain
 * text, so escape first, then linkify, then sanitize as a backstop.
 */
export function blueskyContentHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" rel="nofollow noopener noreferrer" target="_blank">${url}</a>`,
  );
  return sanitizeHtml(`<p>${linked.replace(/\n/g, "<br>")}</p>`);
}

/** Cache remote images locally, as the fediverse side does, so we aren't hot-linking. */
async function localiseImages(images: { fullsize?: string; thumb?: string }[]): Promise<string[]> {
  const out: string[] = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    const remote = img.fullsize || img.thumb;
    if (!remote) continue;
    // Into uploads/fedi/, which is what the retention sweep and the storage
    // scan's cache trim both know how to reclaim. A different prefix would leak.
    const local = await proxyImage(remote);
    if (local) out.push(local);
  }
  return out;
}

export async function syncBlueskyFeed(): Promise<BlueskyFeedResult> {
  const result: BlueskyFeedResult = { fetched: 0, imported: 0, skippedBlocked: 0 };

  const agent = await getBlueskyAgent();
  if (!agent) return result;
  const selfDid = agent.session?.did ?? null;

  const [wm, backfilled] = await Promise.all([
    prisma.siteSetting.findUnique({ where: { key: WATERMARK_KEY } }),
    prisma.siteSetting.findUnique({ where: { key: BACKFILLED_KEY } }),
  ]);
  const watermark = wm?.value ?? null;
  const isFirstRun = backfilled?.value !== "1";

  // Collect newest-first, stopping at the watermark, then reverse so the oldest
  // is written first — same shape as the notifications sync.
  const collected: Record<string, unknown>[] = [];
  let newestFeedAt: string | null = null;
  let cursor: string | undefined;
  let pages = 0;
  let stop = false;

  do {
    const res = await agent.getTimeline({ limit: 100, cursor });
    if (!res.success) break;

    for (const item of res.data.feed) {
      // The FEED position, not the post's own index time. getTimeline is ordered
      // by when something entered your feed, which for a repost is the repost's
      // timestamp — a five-year-old post reposted today sits at the top with an
      // ancient post.indexedAt. Keying the watermark on that would drag the
      // cursor backwards and re-import everything since.
      const reason = item.reason as { indexedAt?: string } | undefined;
      const feedAt = reason?.indexedAt || (item.post as { indexedAt?: string }).indexedAt;
      if (!newestFeedAt && feedAt) newestFeedAt = feedAt;
      if (watermark && feedAt && feedAt <= watermark) {
        stop = true;
        break;
      }
      collected.push(item as unknown as Record<string, unknown>);
      // On the very first run there is no watermark to stop at, so bound it.
      if (isFirstRun && collected.length >= FIRST_RUN_LIMIT) {
        stop = true;
        break;
      }
    }

    cursor = res.data.cursor;
    pages++;
  } while (cursor && !stop && pages < SAFETY_PAGE_CAP);

  result.fetched = collected.length;
  collected.reverse();

  for (const item of collected) {
    const post = item.post as {
      uri?: string;
      author?: FeedAuthor;
      record?: {
        text?: string;
        createdAt?: string;
        reply?: { parent?: { uri?: string }; root?: { uri?: string } };
      };
      embed?: { images?: { fullsize?: string; thumb?: string }[] };
      indexedAt?: string;
      likeCount?: number;
      repostCount?: number;
      replyCount?: number;
      // Our own like/repost records on this post, if any. Present because we
      // call getTimeline authenticated.
      viewer?: { like?: string; repost?: string };
    };
    const reason = item.reason as { $type?: string; by?: FeedAuthor } | undefined;

    const uri = post?.uri;
    const author = post?.author;
    if (!uri || !author?.did || !author.handle) continue;

    // getTimeline is OUR Following feed, which includes our own posts and
    // reposts. Importing those would file our own writing as incoming remote
    // content — isOutgoing false, so the retention sweep would eventually prune
    // it, and it would sit in the feed beside the outgoing row we already have.
    if (author.did === selfDid) continue;

    // A repost puts someone else's post in front of us. Check BOTH identities:
    // blocking the reposter has to stop them using a repost as a side door, and
    // blocking the author has to hold no matter who amplifies them.
    const isRepost = reason?.$type === "app.bsky.feed.defs#reasonRepost";
    const booster = isRepost ? reason?.by : undefined;
    if (
      (await isBlueskyBlocked({ did: author.did, handle: author.handle })) ||
      (booster?.did && (await isBlueskyBlocked({ did: booster.did, handle: booster.handle })))
    ) {
      result.skippedBlocked++;
      continue;
    }

    const record = post.record ?? {};

    // Only download images for rows we don't already hold. Without this every
    // poll re-proxies every image in the window — a fresh copy on disk every
    // fifteen minutes for the same posts, quietly eating the cache budget and
    // re-fetching from Bluesky forever.
    const existing = await prisma.fediPost.findUnique({
      where: { bskyUri: uri },
      select: { mediaUrls: true },
    });
    const mediaUrls = existing ? existing.mediaUrls : await localiseImages(post.embed?.images ?? []);

    const data = {
      source: "bluesky",
      // The DID, so a Bluesky account block matches this column directly.
      actorUri: author.did,
      bskyUri: uri,
      apId: null,
      content: record.text ?? "",
      contentHtml: blueskyContentHtml(record.text ?? ""),
      mediaUrls,
      mediaTypes: mediaUrls.map(() => "image"),
      username: author.handle,
      domain: domainOfHandle(author.handle),
      displayName: author.displayName || null,
      avatarUrl: author.avatar || null,
      publishedAt: new Date(record.createdAt || post.indexedAt || Date.now()),
      // Replies and reposts map onto the same columns the fediverse side uses,
      // so the timeline's existing showReplies / showBoosts toggles just work.
      inReplyTo: record.reply?.parent?.uri ?? null,
      conversationId: record.reply?.root?.uri ?? uri,
      boostedBy: booster?.did ?? null,
      boostedByName: booster?.displayName || booster?.handle || null,
      // getTimeline returns these inline; without storing them the counts strip
      // would show nothing, and there is no endpoint to ask later.
      likeCount: post.likeCount ?? null,
      boostCount: post.repostCount ?? null,
      replyCount: post.replyCount ?? null,
      countsFetchedAt: new Date(),
      // Seed the button state from Bluesky's own view, so a like made in the
      // Bluesky app shows here rather than the heart reading empty.
      likedByMe: Boolean(post.viewer?.like),
      boostedByMe: Boolean(post.viewer?.repost),
    };

    try {
      await prisma.fediPost.upsert({
        where: { bskyUri: uri },
        create: data,
        // Text and profile fields can change upstream; the threading and repost
        // columns are set once at first sight and left alone.
        update: {
          content: data.content,
          contentHtml: data.contentHtml,
          likeCount: data.likeCount,
          boostCount: data.boostCount,
          replyCount: data.replyCount,
          countsFetchedAt: data.countsFetchedAt,
          // likedByMe / boostedByMe are deliberately NOT refreshed here. They
          // come from a viewer snapshot taken before this loop started, and the
          // loop can run for seconds while it proxies images — long enough for
          // the owner to click the heart on a row it is about to write. Seeding
          // on create is safe; overwriting on update would silently undo that
          // click, and nothing ever re-reads viewer state to correct it.
          displayName: data.displayName,
          avatarUrl: data.avatarUrl,
          username: data.username,
        },
      });
      result.imported++;
    } catch (err) {
      console.error("bluesky feed: failed to store %s:", uri, err);
    }
  }

  if (newestFeedAt) {
    await prisma.siteSetting.upsert({
      where: { key: WATERMARK_KEY },
      create: { key: WATERMARK_KEY, value: newestFeedAt },
      update: { value: newestFeedAt },
    });
  }
  if (isFirstRun) {
    await prisma.siteSetting.upsert({
      where: { key: BACKFILLED_KEY },
      create: { key: BACKFILLED_KEY, value: "1" },
      update: { value: "1" },
    });
  }

  return result;
}
