import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Liking and reposting a Bluesky post, and routing by the post's own network
 * (#393).
 *
 * The fediverse actions build a `Like`/`Announce` and deliver it to an inbox.
 * Bluesky has no inbox: you write a record into your own repo referencing the
 * target, and undoing it means deleting that record by its URI.
 *
 * The routing tests matter most. These calls are fire-and-forget from the
 * client, so sending an ActivityPub activity for a Bluesky post fails as
 * *nothing at all* — the heart lights up and no like exists.
 */

const { requireBlueskyAgent } = vi.hoisted(() => ({ requireBlueskyAgent: vi.fn() }));
vi.mock("@/lib/bluesky-agent", () => ({ requireBlueskyAgent }));
const { isBlueskyBlocked } = vi.hoisted(() => ({ isBlueskyBlocked: vi.fn() }));
vi.mock("@/lib/blocks", () => ({ isBlueskyBlocked }));
const { like, unlike, boost, unboost } = vi.hoisted(() => ({
  like: vi.fn(),
  unlike: vi.fn(),
  boost: vi.fn(),
  unboost: vi.fn(),
}));
vi.mock("@/app/api/admin/_actions/fedi-interactions", () => ({ like, unlike, boost, unboost }));
vi.mock("@/lib/db", () => ({
  prisma: { fediPost: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() } },
}));

import {
  blueskyLike,
  blueskyUnlike,
  blueskyRepost,
  blueskyUnrepost,
} from "@/app/api/admin/_actions/bluesky-interactions";
import { interact } from "@/app/api/admin/_actions/interactions";
import { prisma } from "@/lib/db";

const URI = "at://did:plc:ada/app.bsky.feed.post/1";
const CID = "bafyreiabc";

const agent = {
  getPosts: vi.fn(),
  like: vi.fn(),
  deleteLike: vi.fn(),
  repost: vi.fn(),
  deleteRepost: vi.fn(),
};

/** What getPosts returns for the target. */
const viewer = (over: Record<string, unknown> = {}) => ({
  data: { posts: [{ cid: CID, viewer: {}, ...over }] },
});

const FEDI_ROW = { source: "fedi", apId: "https://a.example/notes/1", bskyUri: null };
const BSKY_ROW = { source: "bluesky", apId: null, bskyUri: URI };

beforeEach(() => {
  vi.clearAllMocks();
  requireBlueskyAgent.mockResolvedValue(agent);
  isBlueskyBlocked.mockResolvedValue(false);
  vi.mocked(prisma.fediPost.findFirst).mockResolvedValue({ username: "alice.spam.example" } as never);
  agent.getPosts.mockResolvedValue(viewer());
  vi.mocked(prisma.fediPost.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe("liking on Bluesky", () => {
  it("writes a like record and lights the local flag", async () => {
    const res = await blueskyLike(URI);
    expect(res.status).toBe(200);
    expect(agent.like).toHaveBeenCalledWith(URI, CID);
    expect(prisma.fediPost.updateMany).toHaveBeenCalledWith({
      where: { bskyUri: URI },
      data: { likedByMe: true },
    });
  });

  it("doesn't write a second record when one already exists", async () => {
    // e.g. the like was made in the Bluesky app. Just make our flag agree.
    agent.getPosts.mockResolvedValue(viewer({ viewer: { like: "at://me/like/1" } }));
    await blueskyLike(URI);
    expect(agent.like).not.toHaveBeenCalled();
    expect(prisma.fediPost.updateMany).toHaveBeenCalled();
  });

  it("deletes the like record by URI when unliking", async () => {
    agent.getPosts.mockResolvedValue(viewer({ viewer: { like: "at://me/like/1" } }));
    await blueskyUnlike(URI);
    expect(agent.deleteLike).toHaveBeenCalledWith("at://me/like/1");
  });

  it("refuses to like a post by someone blocked", async () => {
    // Liking notifies the author, so it falls under the guarantee that a block
    // never sends anything to the blocked party.
    isBlueskyBlocked.mockResolvedValue(true);
    const res = await blueskyLike(URI);
    expect(res.status).toBe(409);
    expect(agent.like).not.toHaveBeenCalled();
  });

  it("404s a like on a post that's gone, but still CLEARS on unlike", async () => {
    // Refusing the undo would strand the heart lit with no way to clear it: the
    // row survives locally, and every click would 404 and be re-filled by the
    // client's revert.
    agent.getPosts.mockResolvedValue({ data: { posts: [] } });
    expect((await blueskyLike(URI)).status).toBe(404);

    const undo = await blueskyUnlike(URI);
    expect(undo.status).toBe(200);
    expect(agent.deleteLike).not.toHaveBeenCalled();
    expect(prisma.fediPost.updateMany).toHaveBeenCalledWith({
      where: { bskyUri: URI },
      data: { likedByMe: false },
    });
  });
});

describe("reposting on Bluesky", () => {
  it("writes a repost record", async () => {
    await blueskyRepost(URI);
    expect(agent.repost).toHaveBeenCalledWith(URI, CID);
  });

  it("deletes it by URI when undoing", async () => {
    agent.getPosts.mockResolvedValue(viewer({ viewer: { repost: "at://me/repost/1" } }));
    await blueskyUnrepost(URI);
    expect(agent.deleteRepost).toHaveBeenCalledWith("at://me/repost/1");
  });

  it("re-reads state from Bluesky rather than trusting a cached URI", async () => {
    // Bluesky is the authority on whether we currently like something. A cached
    // record URI goes stale the moment the same account is used from the app —
    // which for a single-owner site is the normal case.
    await blueskyRepost(URI);
    expect(agent.getPosts).toHaveBeenCalledWith({ uris: [URI] });
  });
});

describe("routing by the post's network", () => {
  it("sends a fediverse row to the ActivityPub action", async () => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(FEDI_ROW as never);
    await interact("like", { postId: "p1" });
    expect(like).toHaveBeenCalledWith(expect.objectContaining({ postApId: FEDI_ROW.apId }));
    expect(agent.like).not.toHaveBeenCalled();
  });

  it("sends a Bluesky row to the AT-Protocol action", async () => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(BSKY_ROW as never);
    await interact("like", { postId: "p1" });
    expect(agent.like).toHaveBeenCalledWith(URI, CID);
    expect(like).not.toHaveBeenCalled();
  });

  it.each(["like", "unlike", "boost", "unboost"] as const)("routes %s", async (kind) => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(BSKY_ROW as never);
    agent.getPosts.mockResolvedValue(viewer({ viewer: { like: "at://me/l/1", repost: "at://me/r/1" } }));
    await interact(kind, { postId: "p1" });
    // Whichever it was, it went to Bluesky and not to the fediverse action.
    expect([like, unlike, boost, unboost].some((f) => f.mock.calls.length > 0)).toBe(false);
  });

  it("ignores a client-supplied apId and uses the row's own", async () => {
    // Otherwise a caller could like one post by sending its id alongside a
    // different post's apId.
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(FEDI_ROW as never);
    await interact("like", { postId: "p1", postApId: "https://evil.example/notes/9" });
    expect(like).toHaveBeenCalledWith(
      expect.objectContaining({ postApId: "https://a.example/notes/1" }),
    );
  });

  it("404s an unknown row", async () => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(null as never);
    expect((await interact("like", { postId: "nope" })).status).toBe(404);
  });

  it("400s a Bluesky row with no URI rather than falling through to ActivityPub", async () => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(
      { source: "bluesky", apId: null, bskyUri: null } as never,
    );
    expect((await interact("like", { postId: "p1" })).status).toBe(400);
    expect(like).not.toHaveBeenCalled();
  });

  it("still accepts a bare postApId, so a browser open across a deploy keeps working", async () => {
    await interact("like", { postApId: "https://a.example/notes/1" });
    expect(like).toHaveBeenCalled();
  });

  it("400s when given neither", async () => {
    expect((await interact("like", {})).status).toBe(400);
  });
});

/**
 * #563. `prepare()` called `isBlueskyBlocked({ did })` with no handle. That
 * helper derives its domain candidates from the handle —
 * `actor.handle ? domainChain(…) : []` — so with none it skipped the
 * blockedDomain query entirely and a DOMAIN block collapsed to a DID lookup.
 *
 * Blocking `spam.example` therefore failed to stop a like reaching
 * `alice.spam.example`, and a like or repost notifies the author. The ingest
 * side passed both all along (bluesky-feed.ts), so the block held coming in and
 * not going out — the asymmetry #379 exists to prevent.
 *
 * These assert the HANDLE IS PASSED rather than the outcome, because this suite
 * stubs `isBlueskyBlocked`. The helper's own domain behaviour is covered in
 * domain-blocks.test.ts; what can go wrong here is the caller dropping an
 * argument, and that is what is pinned.
 */
describe("#563 — outbound Bluesky actions honour a domain block", () => {
  it.each([
    ["like", () => blueskyLike(URI)],
    ["unlike", () => blueskyUnlike(URI)],
    ["repost", () => blueskyRepost(URI)],
    ["unrepost", () => blueskyUnrepost(URI)],
  ])("%s asks with the handle, not just the DID", async (_name, call) => {
    agent.getPosts.mockResolvedValue(viewer());
    requireBlueskyAgent.mockResolvedValue(agent);
    await call();
    expect(isBlueskyBlocked).toHaveBeenCalledWith({
      did: "did:plc:ada",
      handle: "alice.spam.example",
    });
  });

  it("passes null rather than undefined when we hold no row for the post", async () => {
    // A handle we don't have must not become a silently-absent argument — that
    // is the exact shape of the bug. null is explicit; the helper treats it as
    // "no domain candidates" and the DID check still runs.
    vi.mocked(prisma.fediPost.findFirst).mockResolvedValue(null as never);
    agent.getPosts.mockResolvedValue(viewer());
    requireBlueskyAgent.mockResolvedValue(agent);
    await blueskyLike(URI);
    expect(isBlueskyBlocked).toHaveBeenCalledWith({ did: "did:plc:ada", handle: null });
  });

  it("still refuses, and never reaches Bluesky, when blocked", async () => {
    isBlueskyBlocked.mockResolvedValue(true);
    requireBlueskyAgent.mockResolvedValue(agent);
    const res = await blueskyLike(URI);
    expect(res.status).toBe(409);
    expect(agent.like).not.toHaveBeenCalled();
    expect(agent.getPosts).not.toHaveBeenCalled();
  });
});
