import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Importing posts from the people we follow on Bluesky (#393).
 *
 * `BlueskyFollowing` was an address book — the graph synced, but nothing the
 * people in it wrote was ever fetched, so a Bluesky follow was a name and a face
 * with no content behind it.
 *
 * Most of these tests exist because the naive version of this importer is
 * subtly wrong in ways that only show up after it has been running a while:
 * a watermark keyed on the wrong timestamp re-imports the world, and re-proxying
 * images every poll quietly fills the disk.
 */

const { getBlueskyAgent } = vi.hoisted(() => ({ getBlueskyAgent: vi.fn() }));
vi.mock("@/lib/bluesky-agent", () => ({ getBlueskyAgent }));
const { isBlueskyBlocked } = vi.hoisted(() => ({ isBlueskyBlocked: vi.fn() }));
vi.mock("@/lib/blocks", () => ({ isBlueskyBlocked }));
const { proxyImage } = vi.hoisted(() => ({ proxyImage: vi.fn() }));
vi.mock("@/lib/fedi-media", () => ({ proxyImage }));
vi.mock("@/lib/sanitize", () => ({ sanitizeHtml: (s: string) => s }));
vi.mock("@/lib/db", () => ({
  prisma: {
    siteSetting: { findUnique: vi.fn(), upsert: vi.fn() },
    fediPost: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { syncBlueskyFeed, domainOfHandle, blueskyContentHtml } from "@/lib/bluesky-feed";
import { prisma } from "@/lib/db";

const SELF = "did:plc:me";
const ADA = { did: "did:plc:ada", handle: "ada.bsky.social", displayName: "Ada", avatar: "https://cdn/a.jpg" };
const MALLORY = { did: "did:plc:mallory", handle: "mallory.spam.example", displayName: "Mallory" };

const feedItem = (over: Record<string, unknown> = {}) => {
  const { post: postOver, ...rest } = over;
  return {
    post: {
      uri: "at://did:plc:ada/app.bsky.feed.post/1",
      author: ADA,
      record: { text: "hello", createdAt: "2026-07-01T10:00:00.000Z" },
      indexedAt: "2026-07-01T10:00:01.000Z",
      likeCount: 3,
      repostCount: 1,
      replyCount: 0,
      ...((postOver as object) ?? {}),
    },
    ...rest,
  };
};

const getTimeline = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getBlueskyAgent.mockResolvedValue({ session: { did: SELF }, getTimeline });
  isBlueskyBlocked.mockResolvedValue(false);
  proxyImage.mockResolvedValue("/uploads/fedi/2026/07/x.webp");
  vi.mocked(prisma.siteSetting.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.siteSetting.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.fediPost.upsert).mockResolvedValue({} as never);
  getTimeline.mockResolvedValue({ success: true, data: { feed: [feedItem()], cursor: undefined } });
});

const created = () => vi.mocked(prisma.fediPost.upsert).mock.calls[0][0].create as Record<string, unknown>;

describe("importing", () => {
  it("does nothing at all when Bluesky isn't configured", async () => {
    getBlueskyAgent.mockResolvedValue(null);
    expect(await syncBlueskyFeed()).toEqual({ fetched: 0, imported: 0, skippedBlocked: 0 });
    expect(getTimeline).not.toHaveBeenCalled();
  });

  it("stores a post as a Bluesky-sourced FediPost row", async () => {
    const r = await syncBlueskyFeed();
    expect(r.imported).toBe(1);
    expect(created()).toMatchObject({
      source: "bluesky",
      // The DID, not the handle: a Bluesky account block is stored as a DID, so
      // this column has to match it directly.
      actorUri: ADA.did,
      bskyUri: "at://did:plc:ada/app.bsky.feed.post/1",
      apId: null,
      username: "ada.bsky.social",
      likeCount: 3,
      boostCount: 1,
    });
  });

  it("escapes the post text rather than storing it as markup", async () => {
    // The timeline renders contentHtml through dangerouslySetInnerHTML, so a
    // Bluesky record's plain text has to be escaped on the way in — otherwise
    // anyone in the following feed can run script in the admin panel.
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { record: { text: "<img src=x onerror=alert(1)>" } } })] },
    });
    await syncBlueskyFeed();
    expect(created().contentHtml).not.toContain("<img");
    expect(created().contentHtml).toContain("&lt;img");
  });

  it("skips our own posts", async () => {
    // getTimeline is OUR Following feed, so it includes our own writing.
    // Importing it would file it as incoming remote content — isOutgoing false,
    // so the retention sweep would eventually prune our own posts.
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { author: { did: SELF, handle: "me.bsky.social" } } })] },
    });
    const r = await syncBlueskyFeed();
    expect(r.imported).toBe(0);
    expect(prisma.fediPost.upsert).not.toHaveBeenCalled();
  });
});

describe("blocks", () => {
  it("skips a blocked author", async () => {
    isBlueskyBlocked.mockResolvedValue(true);
    const r = await syncBlueskyFeed();
    expect(r.skippedBlocked).toBe(1);
    expect(prisma.fediPost.upsert).not.toHaveBeenCalled();
  });

  it("skips a repost by a blocked REPOSTER, even when the author is fine", async () => {
    // A repost is a side door: blocking someone has to stop them putting
    // content in front of you, whoever wrote it.
    isBlueskyBlocked.mockImplementation(async (a: { did: string }) => a.did === MALLORY.did);
    getTimeline.mockResolvedValue({
      success: true,
      data: {
        feed: [feedItem({ reason: { $type: "app.bsky.feed.defs#reasonRepost", by: MALLORY, indexedAt: "2026-07-02T00:00:00.000Z" } })],
      },
    });
    const r = await syncBlueskyFeed();
    expect(r.skippedBlocked).toBe(1);
    expect(prisma.fediPost.upsert).not.toHaveBeenCalled();
  });

  it("records a repost by an unblocked reposter as a boost", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: {
        feed: [feedItem({ reason: { $type: "app.bsky.feed.defs#reasonRepost", by: MALLORY, indexedAt: "2026-07-02T00:00:00.000Z" } })],
      },
    });
    await syncBlueskyFeed();
    // Maps onto the same columns the fediverse side uses, so the feed's existing
    // boost toggle works on it unchanged.
    expect(created()).toMatchObject({ boostedBy: MALLORY.did, boostedByName: "Mallory" });
  });
});

describe("the watermark", () => {
  it("is keyed on the FEED position, not the post's own index time", async () => {
    // getTimeline is ordered by when something entered your feed. For a repost
    // that's the repost's timestamp — a five-year-old post reposted today sits
    // at the top carrying an ancient post.indexedAt. Keying on that would drag
    // the cursor backwards and re-import everything since.
    getTimeline.mockResolvedValue({
      success: true,
      data: {
        feed: [
          feedItem({
            post: { indexedAt: "2021-01-01T00:00:00.000Z" },
            reason: { $type: "app.bsky.feed.defs#reasonRepost", by: MALLORY, indexedAt: "2026-07-02T00:00:00.000Z" },
          }),
        ],
      },
    });

    await syncBlueskyFeed();

    const wm = vi
      .mocked(prisma.siteSetting.upsert)
      .mock.calls.find((c) => (c[0].where as { key: string }).key === "bsky_feed_last_seen");
    expect((wm?.[0].create as { value: string }).value).toBe("2026-07-02T00:00:00.000Z");
  });

  it("stops at the watermark instead of walking the whole timeline", async () => {
    vi.mocked(prisma.siteSetting.findUnique).mockImplementation((async (a: { where: { key: string } }) =>
      a.where.key === "bsky_feed_last_seen" ? { value: "2026-07-01T10:00:01.000Z" } : { value: "1" }) as never);
    const r = await syncBlueskyFeed();
    expect(r.fetched).toBe(0);
    expect(prisma.fediPost.upsert).not.toHaveBeenCalled();
  });

  it("bounds the very first run, which has no watermark to stop at", async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      feedItem({ post: { uri: `at://did:plc:ada/app.bsky.feed.post/${i}`, indexedAt: `2026-07-01T10:00:${String(i).padStart(2, "0")}.000Z` } }),
    );
    getTimeline.mockResolvedValue({ success: true, data: { feed: many, cursor: "next" } });
    const r = await syncBlueskyFeed();
    expect(r.fetched).toBe(50);
  });
});

/**
 * #512. Bluesky posts arrived with their text and no photo.
 *
 * Every fixture here carries a real `$type`, because that is what the protocol
 * sends and what the SDK's `isView` guards test. The two tests that used to live
 * here passed a bare `{ images: [...] }` with no discriminant — which is exactly
 * the shape the old hand-written cast believed in, and is why they went on
 * passing while five of the six embed shapes imported nothing.
 */
const IMAGES = (...urls: string[]) => ({
  $type: "app.bsky.embed.images#view",
  images: urls.map((fullsize) => ({ fullsize, thumb: `${fullsize}?thumb`, alt: "" })),
});

describe("media — every embed shape, not just one (#512)", () => {
  const feedWith = (embed: unknown) =>
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed } })] },
    });

  it("caches images locally rather than hot-linking Bluesky's CDN", async () => {
    feedWith(IMAGES("https://cdn.bsky.app/a.jpg"));
    await syncBlueskyFeed();
    expect(proxyImage).toHaveBeenCalledWith("https://cdn.bsky.app/a.jpg");
    // Into uploads/fedi/, which is what the retention sweep and the cache trim
    // both know how to reclaim.
    expect(created().mediaUrls).toEqual(["/uploads/fedi/2026/07/x.webp"]);
  });

  it("reads a quote-with-a-photo, which is the common case that went blank", async () => {
    // recordWithMedia keeps the pictures at `.media.images`, so `.images` on the
    // embed itself is undefined — the whole of the reported bug in one shape.
    feedWith({
      $type: "app.bsky.embed.recordWithMedia#view",
      record: { $type: "app.bsky.embed.record#view", record: {} },
      media: IMAGES("https://cdn.bsky.app/quoted.jpg"),
    });
    await syncBlueskyFeed();
    expect(proxyImage).toHaveBeenCalledWith("https://cdn.bsky.app/quoted.jpg");
    expect(created().mediaUrls).toHaveLength(1);
  });

  it("reads a gallery, taking fullsize rather than the thumbnail", async () => {
    feedWith({
      $type: "app.bsky.embed.gallery#view",
      items: [
        { $type: "app.bsky.embed.gallery#viewImage", fullsize: "https://cdn/g1.jpg", thumbnail: "https://cdn/g1-t.jpg", alt: "" },
        { $type: "app.bsky.embed.gallery#viewImage", fullsize: "https://cdn/g2.jpg", thumbnail: "https://cdn/g2-t.jpg", alt: "" },
      ],
    });
    await syncBlueskyFeed();
    expect(proxyImage).toHaveBeenCalledWith("https://cdn/g1.jpg");
    expect(proxyImage).toHaveBeenCalledWith("https://cdn/g2.jpg");
    expect(proxyImage).not.toHaveBeenCalledWith("https://cdn/g1-t.jpg");
  });

  it("stores a video's poster frame, since the playlist isn't fetchable", async () => {
    // `playlist` is HLS and proxyVideo only accepts video/* — the still is the
    // only asset here we can actually keep. It renders as a photo, deliberately.
    feedWith({
      $type: "app.bsky.embed.video#view",
      cid: "bafy",
      playlist: "https://video.bsky.app/x/playlist.m3u8",
      thumbnail: "https://video.bsky.app/x/thumb.jpg",
    });
    await syncBlueskyFeed();
    expect(proxyImage).toHaveBeenCalledWith("https://video.bsky.app/x/thumb.jpg");
    expect(proxyImage).not.toHaveBeenCalledWith("https://video.bsky.app/x/playlist.m3u8");
    expect(created().mediaTypes).toEqual(["image"]);
  });

  it("turns a link card into the embed columns, not into an attachment", async () => {
    // Putting a link's thumbnail in mediaUrls would show it as a photo the
    // author never posted. The embed* columns already render as a card.
    feedWith({
      $type: "app.bsky.embed.external#view",
      external: {
        uri: "https://example.com/article",
        title: "An article",
        description: "About things",
        thumb: "https://cdn/og.jpg",
      },
    });
    await syncBlueskyFeed();
    const c = created();
    expect(c.mediaUrls).toEqual([]);
    expect(c.embedUrl).toBe("https://example.com/article");
    expect(c.embedTitle).toBe("An article");
    expect(c.embedDescription).toBe("About things");
    expect(c.embedImage).toBe("/uploads/fedi/2026/07/x.webp");
  });

  it("reads a plain quote's pictures from the quoted post", async () => {
    feedWith({
      $type: "app.bsky.embed.record#view",
      record: {
        $type: "app.bsky.embed.record#viewRecord",
        uri: "at://did:plc:bob/app.bsky.feed.post/9",
        cid: "bafy",
        author: { did: "did:plc:bob", handle: "bob.bsky.social" },
        value: {},
        indexedAt: "2026-07-01T09:00:00.000Z",
        embeds: [IMAGES("https://cdn/quoted-photo.jpg")],
      },
    });
    await syncBlueskyFeed();
    expect(proxyImage).toHaveBeenCalledWith("https://cdn/quoted-photo.jpg");
  });

  it("stores nothing, and fetches nothing, for a post with no embed", async () => {
    await syncBlueskyFeed();
    expect(proxyImage).not.toHaveBeenCalled();
    expect(created().mediaUrls).toEqual([]);
  });

  it("ignores an embed shape it doesn't know, rather than throwing", async () => {
    feedWith({ $type: "app.bsky.embed.somethingNew#view", stuff: [1, 2, 3] });
    await syncBlueskyFeed();
    expect(created().mediaUrls).toEqual([]);
  });
});

describe("media — a failed proxy falls back, it does not delete (#512)", () => {
  it("keeps the remote URL when proxying returns null", async () => {
    // proxyImage returns null BY DESIGN when the media cache is set to 0, which
    // the panel documents as "media then loads from the original server". The
    // old `if (local) push(local)` deleted every Bluesky image instead — the
    // exact inverse of the promise, and only on this one caller.
    proxyImage.mockResolvedValue(null);
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed: IMAGES("https://cdn.bsky.app/a.jpg") } })] },
    });
    await syncBlueskyFeed();
    expect(created().mediaUrls).toEqual(["https://cdn.bsky.app/a.jpg"]);
  });

  it("keeps the three media arrays the same length whichever way it went", async () => {
    // restoreEvictedMedia skips any row where they disagree, so a sometimes-short
    // parallel array is worse than none at all.
    proxyImage.mockResolvedValueOnce(null).mockResolvedValue("/uploads/fedi/2026/07/x.webp");
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed: IMAGES("https://cdn/a.jpg", "https://cdn/b.jpg") } })] },
    });
    await syncBlueskyFeed();
    const c = created();
    expect(c.mediaUrls).toEqual(["https://cdn/a.jpg", "/uploads/fedi/2026/07/x.webp"]);
    expect(c.mediaRemoteUrls).toEqual(["https://cdn/a.jpg", "https://cdn/b.jpg"]);
    expect((c.mediaTypes as string[]).length).toBe((c.mediaUrls as string[]).length);
  });

  it("records the originals so an evicted file can be restored (#478)", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed: IMAGES("https://cdn.bsky.app/a.jpg") } })] },
    });
    await syncBlueskyFeed();
    expect(created().mediaRemoteUrls).toEqual(["https://cdn.bsky.app/a.jpg"]);
  });
});

describe("media — a row stored empty can gain its pictures (#512)", () => {
  const updated = () => vi.mocked(prisma.fediPost.upsert).mock.calls[0][0].update as Record<string, unknown>;

  it("does NOT re-proxy images for a row that already has them", async () => {
    // Otherwise every poll downloads every image in the window again — a fresh
    // copy on disk every fifteen minutes, forever.
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({
      mediaUrls: ["/uploads/fedi/old.webp"],
      mediaRemoteUrls: ["https://cdn/old.jpg"],
      embedUrl: null,
    } as never);
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed: IMAGES("https://cdn.bsky.app/a.jpg") } })] },
    });
    await syncBlueskyFeed();
    expect(proxyImage).not.toHaveBeenCalled();
    expect(updated().mediaUrls).toBeUndefined();
  });

  it("DOES retry a row holding an empty array, and writes the result", async () => {
    // The old guard branched on the row EXISTING. `[]` is truthy, so a post that
    // landed blank stayed blank forever — meaning a fix alone repaired nothing.
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({
      mediaUrls: [],
      mediaRemoteUrls: [],
      embedUrl: null,
    } as never);
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed: IMAGES("https://cdn.bsky.app/a.jpg") } })] },
    });
    await syncBlueskyFeed();
    expect(proxyImage).toHaveBeenCalledWith("https://cdn.bsky.app/a.jpg");
    // Written on the UPDATE path too. Without this the download happens on every
    // single poll and is discarded every single time.
    expect(updated().mediaUrls).toEqual(["/uploads/fedi/2026/07/x.webp"]);
    expect(updated().mediaRemoteUrls).toEqual(["https://cdn.bsky.app/a.jpg"]);
  });

  it("fills in missing originals for an existing row without re-downloading", async () => {
    // Rows written before #512 have media but no mediaRemoteUrls, so a cache trim
    // leaves a broken image with no way back. Same count means the live response
    // IS that list of originals, in the order they were written.
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({
      mediaUrls: ["/uploads/fedi/old.webp"],
      mediaRemoteUrls: [],
      embedUrl: null,
    } as never);
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed: IMAGES("https://cdn.bsky.app/a.jpg") } })] },
    });
    await syncBlueskyFeed();
    expect(proxyImage).not.toHaveBeenCalled();
    expect(updated().mediaRemoteUrls).toEqual(["https://cdn.bsky.app/a.jpg"]);
    expect(updated().mediaUrls).toBeUndefined();
  });

  it("leaves the originals alone when the counts disagree", async () => {
    // Pairing by index across lists of different lengths would attach one photo's
    // original to a different photo's file.
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({
      mediaUrls: ["/uploads/fedi/one.webp"],
      mediaRemoteUrls: [],
      embedUrl: null,
    } as never);
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed: IMAGES("https://cdn/a.jpg", "https://cdn/b.jpg") } })] },
    });
    await syncBlueskyFeed();
    expect(updated().mediaRemoteUrls).toBeUndefined();
  });
});

describe("interaction state", () => {
  it("seeds likedByMe from Bluesky's own view of the post", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { viewer: { like: "at://me/like/1" } } })] },
    });
    await syncBlueskyFeed();
    expect(created()).toMatchObject({ likedByMe: true, boostedByMe: false });
  });

  it("never overwrites likedByMe on update", async () => {
    // The viewer snapshot predates this loop, which runs for seconds while it
    // proxies images — long enough for the owner to click the heart on a row it
    // is about to write. Overwriting would silently undo that click, and nothing
    // re-reads viewer state to correct it.
    await syncBlueskyFeed();
    const update = vi.mocked(prisma.fediPost.upsert).mock.calls[0][0].update as Record<string, unknown>;
    expect(update).not.toHaveProperty("likedByMe");
    expect(update).not.toHaveProperty("boostedByMe");
  });
});

describe("helpers", () => {
  it("takes the registrable part of a handle as the domain", () => {
    expect(domainOfHandle("ada.bsky.social")).toBe("bsky.social");
    expect(domainOfHandle("someone.com")).toBe("someone.com");
  });

  it("linkifies URLs without letting markup through", () => {
    const html = blueskyContentHtml("see https://example.com <b>x</b>");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("<b>");
  });
});
