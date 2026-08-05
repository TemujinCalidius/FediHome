import {
  AppBskyEmbedExternal,
  type AppBskyFeedDefs,
  AppBskyEmbedGallery,
  AppBskyEmbedImages,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
  AppBskyEmbedVideo,
} from "@atproto/api";
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
/**
 * Our cap on stored assets per post, not Bluesky's (#512). An `images` embed
 * holds at most four; a `gallery` holds up to ten. Ten covers both without a
 * single post being able to pull an unbounded amount into the media cache.
 */
const MAX_MEDIA = 10;

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

/**
 * The embed union exactly as the SDK declares it on `PostView`.
 *
 * Naming the WHOLE union is the point (#512) — it is what lets the `isView`
 * guards narrow, and it is the opposite of the cast this fix removes, which
 * asserted a single member of it. The guards can't narrow from `unknown`: the
 * result is `{ $type: "…" }` with no fields, so every property access fails.
 */
type PostEmbed = NonNullable<AppBskyFeedDefs.PostView["embed"]>;

/** A link card, mapped onto the `embed*` columns the fediverse side already uses. */
interface LinkCard {
  url: string;
  title: string | null;
  description: string | null;
  thumb: string | null;
}

/**
 * Pull the picture URLs, and any link card, out of a post's embed (#512).
 *
 * `PostView.embed` is a SIX-MEMBER union and this used to read one member of it:
 * the code hand-wrote `embed?: { images?: … }` over `item.post`, so
 * `post.embed?.images` was `undefined` for everything else and the post was
 * stored with no media at all. Quote-with-a-photo — an extremely common Bluesky
 * post — went in blank, which is what people were noticing.
 *
 * **`tsc` could never have caught that.** The SDK types the union properly; the
 * cast asserted one variant over the whole of it, so the compiler was told the
 * answer and agreed. The fix is to name the union and nothing narrower, and let
 * the SDK's own `isView` guards do the narrowing — they test the `$type`
 * discriminant the protocol actually sends, so a variant we don't handle falls
 * out of the bottom of this function rather than silently reading as empty.
 *
 * Where each one keeps its pictures, verified against @atproto/api 0.20.37
 * rather than assumed:
 *
 * | view              | pictures live at                          |
 * |-------------------|-------------------------------------------|
 * | `images`          | `images[].fullsize`                       |
 * | `gallery`         | `items[].fullsize` (NOT `.thumbnail`)     |
 * | `recordWithMedia` | `media.…` — recurse, it's one of the above |
 * | `record`          | the QUOTED post's own `embeds[]`          |
 * | `video`           | `thumbnail` — see below                   |
 * | `external`        | `external.thumb`, plus the card fields    |
 *
 * **Video stores the still, not the video.** `playlist` is an HLS `.m3u8` and
 * `proxyVideo` only accepts a `video/*` content type, so the poster frame is the
 * only asset here we can actually fetch. It renders as a photo with no play
 * affordance, which is a real compromise — and better than the post appearing to
 * have nothing in it.
 *
 * **External becomes a link card, not an attachment.** `embedUrl`/`embedTitle`/
 * `embedDescription`/`embedImage` already exist and the timeline already renders
 * them for fediverse posts; putting a link thumbnail in `mediaUrls` instead would
 * show it as a photo the author never posted.
 */
function extractEmbed(
  embed: PostEmbed | undefined,
  depth = 0,
): { images: string[]; card: LinkCard | null } {
  const none = { images: [] as string[], card: null };
  // A quote of a quote is as far as this goes. Not for cycles — the API returns
  // a tree — but because the second level's pictures belong to a post two hops
  // from anything the owner chose to follow.
  if (!embed || depth > 1) return none;

  if (AppBskyEmbedImages.isView(embed)) {
    return { images: embed.images.map((i) => i.fullsize || i.thumb).filter(Boolean), card: null };
  }

  if (AppBskyEmbedGallery.isView(embed)) {
    // `items` is a union array; anything that isn't a ViewImage is skipped
    // rather than guessed at.
    const images = embed.items
      .filter(AppBskyEmbedGallery.isViewImage)
      .map((i) => i.fullsize || i.thumbnail)
      .filter(Boolean);
    return { images, card: null };
  }

  if (AppBskyEmbedVideo.isView(embed)) {
    return { images: embed.thumbnail ? [embed.thumbnail] : [], card: null };
  }

  if (AppBskyEmbedExternal.isView(embed)) {
    const e = embed.external;
    return {
      images: [],
      card: {
        url: e.uri,
        title: e.title || null,
        description: e.description || null,
        thumb: e.thumb || null,
      },
    };
  }

  if (AppBskyEmbedRecordWithMedia.isView(embed)) {
    // Quote-with-a-photo. The photo is the poster's own, so it is theirs to
    // show — the quoted post is reached through `.record`, which is deliberately
    // NOT followed here: that would stack a stranger's pictures on top of the
    // ones this post actually carries.
    return extractEmbed(embed.media, depth + 1);
  }

  if (AppBskyEmbedRecord.isView(embed)) {
    // A plain quote. The pictures belong to the quoted post, and showing them is
    // the point — a quote of a photo reads as empty without them.
    const rec = embed.record;
    if (!AppBskyEmbedRecord.isViewRecord(rec) || !rec.embeds?.length) return none;
    const inner = rec.embeds.map((e) => extractEmbed(e, depth + 1));
    return {
      images: inner.flatMap((r) => r.images),
      card: inner.find((r) => r.card)?.card ?? null,
    };
  }

  return none;
}

/**
 * Cache remote images locally, as the fediverse side does, so we aren't
 * hot-linking — and keep the original URL for each one.
 *
 * **`urls.push(local || remote)`, not `if (local) push(local)` (#512).** The old
 * form dropped the picture entirely whenever proxying failed, and `proxyImage`
 * returns null *by design* when the media cache is set to 0. So the setting
 * documented as "media then loads from the original server" deleted every
 * Bluesky image instead — the exact inverse. `proxyImage`'s own doc comment
 * states the contract ("returning null makes every caller fall back to the
 * remote URL"); `processAttachments` in fedi-media.ts honours it, and this was
 * the one caller that didn't.
 *
 * `remotes` is pushed for EVERY entry including passthroughs, because a parallel
 * array that is sometimes short is worse than no array at all — `restoreEvictedMedia`
 * skips any row where the two lengths disagree.
 */
async function localiseImages(
  images: string[],
): Promise<{ urls: string[]; remotes: string[] }> {
  const urls: string[] = [];
  const remotes: string[] = [];
  for (const remote of images.slice(0, MAX_MEDIA)) {
    // Into uploads/fedi/, which is what the retention sweep and the storage
    // scan's cache trim both know how to reclaim. A different prefix would leak.
    const local = await proxyImage(remote);
    urls.push(local || remote);
    remotes.push(remote);
  }
  return { urls, remotes };
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
      // `unknown` on purpose (#512). This is a six-member union and the previous
      // shape asserted one member of it, which is why nothing caught the bug.
      // `extractEmbed` narrows with the SDK's own guards instead.
      embed?: unknown;
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

    // The one cast, and it asserts only that this is the embed union — which is
    // what getTimeline returns. Naming a MEMBER of it here is the bug (#512).
    const extracted = extractEmbed(post.embed as PostEmbed | undefined);

    // Only download images for rows that don't already HAVE them. Without the
    // first half, every poll re-proxies every image in the window — a fresh copy
    // on disk every fifteen minutes for the same posts, quietly eating the cache
    // budget and re-fetching from Bluesky forever.
    //
    // But this used to branch on the row EXISTING (#512). `mediaUrls: []` is
    // truthy, so a post stored empty — which, before the embed fix above, was
    // most of them — copied that emptiness forward on every single poll and
    // could never gain its pictures, even once the bug was fixed. Branching on
    // whether media is actually present makes anything still inside the poll
    // window heal itself on the next tick, at no cost for posts that genuinely
    // have none: `extractEmbed` returns nothing for them, so nothing is fetched.
    const existing = await prisma.fediPost.findUnique({
      where: { bskyUri: uri },
      select: { mediaUrls: true, mediaRemoteUrls: true, embedUrl: true },
    });

    let mediaUrls: string[];
    let mediaRemoteUrls: string[];
    if (existing?.mediaUrls.length) {
      mediaUrls = existing.mediaUrls;
      // Free repair, no re-download (#512). Rows stored before this fix have an
      // empty `mediaRemoteUrls`, which makes `restoreEvictedMedia` skip them —
      // so a cache trim leaves a broken image with no way back. When the live
      // response still carries the same number of pictures, it IS the list of
      // originals for those files, in the same order they were written.
      mediaRemoteUrls =
        existing.mediaRemoteUrls.length === 0 && extracted.images.length === existing.mediaUrls.length
          ? extracted.images
          : existing.mediaRemoteUrls;
    } else {
      const localised = await localiseImages(extracted.images);
      mediaUrls = localised.urls;
      mediaRemoteUrls = localised.remotes;
    }
    // Uniform, and correct rather than accidentally correct: every asset stored
    // from Bluesky is a still image, including a video embed's poster frame.
    const mediaTypes = mediaUrls.map(() => "image");

    // The card's thumbnail is a local proxied path like every other embedImage,
    // falling back to the remote URL on the same contract as the media above.
    const cardImage = extracted.card?.thumb
      ? ((await proxyImage(extracted.card.thumb)) ?? extracted.card.thumb)
      : null;

    const data = {
      source: "bluesky",
      // The DID, so a Bluesky account block matches this column directly.
      actorUri: author.did,
      bskyUri: uri,
      apId: null,
      content: record.text ?? "",
      contentHtml: blueskyContentHtml(record.text ?? ""),
      mediaUrls,
      mediaTypes,
      // #512: never written before, so `restoreEvictedMedia` skipped every
      // Bluesky row and a cache trim left a permanently broken image.
      mediaRemoteUrls,
      embedUrl: extracted.card?.url ?? null,
      embedTitle: extracted.card?.title ?? null,
      embedDescription: extracted.card?.description ?? null,
      embedImage: cardImage,
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

    // What the update is allowed to touch about media, and nothing more (#512).
    //
    // "Set once at first sight" is right for threading and repost columns, but it
    // is why the media fix would otherwise repair nothing: an existing row with an
    // empty `mediaUrls` takes the localise branch above, downloads the pictures,
    // and then the update silently drops them — so the next poll downloads them
    // again, forever. Filling a gap is allowed; overwriting media we already hold
    // is not, so each clause requires the stored value to be absent.
    const mediaRepair = mediaUrls.length && !existing?.mediaUrls.length
      ? { mediaUrls, mediaTypes, mediaRemoteUrls }
      : mediaRemoteUrls.length && !existing?.mediaRemoteUrls.length
        ? { mediaRemoteUrls }
        : {};
    const cardRepair =
      extracted.card && !existing?.embedUrl
        ? {
            embedUrl: data.embedUrl,
            embedTitle: data.embedTitle,
            embedDescription: data.embedDescription,
            embedImage: data.embedImage,
          }
        : {};

    try {
      await prisma.fediPost.upsert({
        where: { bskyUri: uri },
        create: data,
        // Text and profile fields can change upstream; the threading and repost
        // columns are set once at first sight and left alone.
        update: {
          ...mediaRepair,
          ...cardRepair,
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
