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

describe("media", () => {
  it("caches images locally rather than hot-linking Bluesky's CDN", async () => {
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed: { images: [{ fullsize: "https://cdn.bsky.app/a.jpg" }] } } })] },
    });
    await syncBlueskyFeed();
    expect(proxyImage).toHaveBeenCalledWith("https://cdn.bsky.app/a.jpg");
    // Into uploads/fedi/, which is what the retention sweep and the cache trim
    // both know how to reclaim.
    expect(created().mediaUrls).toEqual(["/uploads/fedi/2026/07/x.webp"]);
  });

  it("does NOT re-proxy images for a row we already hold", async () => {
    // Otherwise every poll downloads every image in the window again — a fresh
    // copy on disk every fifteen minutes, forever.
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({ mediaUrls: ["/uploads/fedi/old.webp"] } as never);
    getTimeline.mockResolvedValue({
      success: true,
      data: { feed: [feedItem({ post: { embed: { images: [{ fullsize: "https://cdn.bsky.app/a.jpg" }] } } })] },
    });
    await syncBlueskyFeed();
    expect(proxyImage).not.toHaveBeenCalled();
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
