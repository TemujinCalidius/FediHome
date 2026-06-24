import { describe, it, expect, vi, beforeEach } from "vitest";

const { login, listNotifications } = vi.hoisted(() => ({
  login: vi.fn(),
  listNotifications: vi.fn(),
}));

vi.mock("@atproto/api", () => ({
  BskyAgent: class {
    login = login;
    listNotifications = listNotifications;
  },
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    post: { findMany: vi.fn() },
    siteSetting: { findUnique: vi.fn(), upsert: vi.fn() },
    blueskyInteraction: { create: vi.fn() },
    blueskyReply: { create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/push", () => ({ sendPushToOwner: vi.fn() }));

import { syncBlueskyNotifications } from "../bluesky-notifications";
import { prisma } from "@/lib/db";
import { sendPushToOwner } from "@/lib/push";

const OWN_URI = "at://did:plc:me/app.bsky.feed.post/abc";
const ALICE = { did: "did:plc:alice", handle: "alice.bsky.social", displayName: "Alice", avatar: "https://a/av.jpg" };

function likeNotif(over: Record<string, unknown> = {}) {
  return {
    uri: "at://did:plc:alice/app.bsky.feed.like/1",
    cid: "c1",
    author: ALICE,
    reason: "like",
    reasonSubject: OWN_URI,
    record: { subject: { uri: OWN_URI }, createdAt: "2026-02-01T00:00:00.000Z" },
    indexedAt: "2026-02-01T00:00:00.000Z",
    isRead: false,
    ...over,
  };
}

/** Make findUnique report the first backfill as already done (isFirstRun=false). */
function alreadyBackfilled() {
  // Calls happen in Promise.all order: [bsky_notif_last_seen, bsky_notif_backfilled].
  vi.mocked(prisma.siteSetting.findUnique)
    .mockResolvedValueOnce(null as never)
    .mockResolvedValueOnce({ value: "1" } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BLUESKY_HANDLE = "me.bsky.social";
  process.env.BLUESKY_APP_PASSWORD = "pw";
  login.mockResolvedValue(undefined);
  vi.mocked(prisma.post.findMany).mockResolvedValue([
    { id: "p1", slug: "hello", title: "Hello", blueskyUri: OWN_URI },
  ] as never);
  vi.mocked(prisma.siteSetting.findUnique).mockResolvedValue(null as never); // first run
  vi.mocked(prisma.siteSetting.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.blueskyInteraction.create).mockResolvedValue({} as never);
  vi.mocked(prisma.blueskyReply.create).mockResolvedValue({} as never);
  vi.mocked(prisma.blueskyReply.update).mockResolvedValue({} as never);
  vi.mocked(sendPushToOwner).mockResolvedValue(undefined);
  listNotifications.mockResolvedValue({ success: true, data: { notifications: [], cursor: undefined } });
});

describe("syncBlueskyNotifications", () => {
  it("returns zeros (and never logs in) when credentials are missing", async () => {
    delete process.env.BLUESKY_HANDLE;
    const r = await syncBlueskyNotifications();
    expect(r).toEqual({ likes: 0, reposts: 0, replies: 0, mentions: 0, quotes: 0, follows: 0, pushed: 0 });
    expect(login).not.toHaveBeenCalled();
  });

  it("skips a like whose subject isn't one of our posts (owned filter)", async () => {
    const foreign = "at://did:plc:stranger/app.bsky.feed.post/zzz";
    listNotifications.mockResolvedValue({
      success: true,
      data: {
        notifications: [likeNotif({ reasonSubject: foreign, record: { subject: { uri: foreign }, createdAt: "2026-02-01T00:00:00.000Z" } })],
        cursor: undefined,
      },
    });
    const r = await syncBlueskyNotifications();
    expect(prisma.blueskyInteraction.create).not.toHaveBeenCalled();
    expect(r.likes).toBe(0);
  });

  it("routes a like → BlueskyInteraction and a reply → BlueskyReply", async () => {
    const reply = {
      uri: "at://did:plc:carol/app.bsky.feed.post/9",
      cid: "c2",
      author: { did: "did:plc:carol", handle: "carol.bsky.social", displayName: "Carol", avatar: null },
      reason: "reply",
      record: { reply: { parent: { uri: OWN_URI } }, text: "nice!", createdAt: "2026-02-02T00:00:00.000Z" },
      indexedAt: "2026-02-02T00:00:00.000Z",
      isRead: false,
    };
    listNotifications.mockResolvedValue({ success: true, data: { notifications: [likeNotif(), reply], cursor: undefined } });

    const r = await syncBlueskyNotifications();

    expect(prisma.blueskyInteraction.create).toHaveBeenCalledTimes(1);
    expect(prisma.blueskyInteraction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "like", subjectUri: OWN_URI, notifUri: "at://did:plc:alice/app.bsky.feed.like/1" }),
    });
    expect(prisma.blueskyReply.create).toHaveBeenCalledTimes(1);
    expect(prisma.blueskyReply.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ postId: "p1", blueskyUri: "at://did:plc:carol/app.bsky.feed.post/9", content: "nice!" }),
    });
    expect(r.likes).toBe(1);
    expect(r.replies).toBe(1);
  });

  it("records mention + follow with a null subjectUri", async () => {
    const mention = {
      uri: "at://did:plc:dave/app.bsky.feed.post/m", cid: "cm",
      author: { did: "did:plc:dave", handle: "dave.bsky.social", displayName: null, avatar: null },
      reason: "mention", record: { text: "hey @me", createdAt: "2026-02-04T00:00:00.000Z" },
      indexedAt: "2026-02-04T00:00:00.000Z", isRead: false,
    };
    const follow = {
      uri: "at://did:plc:erin/app.bsky.graph.follow/f", cid: "cf",
      author: { did: "did:plc:erin", handle: "erin.bsky.social", displayName: "Erin", avatar: null },
      reason: "follow", record: { createdAt: "2026-02-05T00:00:00.000Z" },
      indexedAt: "2026-02-05T00:00:00.000Z", isRead: false,
    };
    listNotifications.mockResolvedValue({ success: true, data: { notifications: [mention, follow], cursor: undefined } });

    const r = await syncBlueskyNotifications();
    expect(r.mentions).toBe(1);
    expect(r.follows).toBe(1);
    expect(prisma.blueskyInteraction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "mention", subjectUri: null, postUri: "at://did:plc:dave/app.bsky.feed.post/m" }),
    });
    expect(prisma.blueskyInteraction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "follow", subjectUri: null }),
    });
  });

  it("first run backfills WITHOUT pushing and sets watermark + backfilled flag", async () => {
    listNotifications.mockResolvedValue({ success: true, data: { notifications: [likeNotif()], cursor: undefined } });

    const r = await syncBlueskyNotifications();

    expect(prisma.blueskyInteraction.create).toHaveBeenCalledTimes(1);
    expect(sendPushToOwner).not.toHaveBeenCalled(); // no historical storm
    expect(prisma.siteSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "bsky_notif_last_seen" } }));
    expect(prisma.siteSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "bsky_notif_backfilled" } }));
    expect(r.likes).toBe(1);
  });

  it("treats an already-ingested item (P2002) as not-new — no count, no push", async () => {
    alreadyBackfilled();
    vi.mocked(prisma.blueskyInteraction.create).mockRejectedValue({ code: "P2002" } as never);
    listNotifications.mockResolvedValue({ success: true, data: { notifications: [likeNotif()], cursor: undefined } });

    const r = await syncBlueskyNotifications();
    expect(r.likes).toBe(0);
    expect(sendPushToOwner).not.toHaveBeenCalled();
  });

  it("pushes a single new interaction on a subsequent run", async () => {
    alreadyBackfilled();
    listNotifications.mockResolvedValue({ success: true, data: { notifications: [likeNotif()], cursor: undefined } });

    await syncBlueskyNotifications();
    expect(sendPushToOwner).toHaveBeenCalledTimes(1);
    expect(sendPushToOwner).toHaveBeenCalledWith(expect.objectContaining({ type: "like", url: "/post/hello" }));
  });

  it("survives a malformed record.createdAt (falls back, still ingests)", async () => {
    listNotifications.mockResolvedValue({
      success: true,
      data: {
        notifications: [likeNotif({ record: { subject: { uri: OWN_URI }, createdAt: "not-a-date" } })],
        cursor: undefined,
      },
    });

    const r = await syncBlueskyNotifications();

    // No RangeError thrown; the interaction is still recorded with a valid date,
    // and the watermark advances (so the poison item isn't re-fetched forever).
    expect(r.likes).toBe(1);
    const arg = vi.mocked(prisma.blueskyInteraction.create).mock.calls[0][0] as { data: { createdAt: Date } };
    expect(isNaN(arg.data.createdAt.getTime())).toBe(false);
    expect(prisma.siteSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "bsky_notif_last_seen" } }));
  });

  it("coalesces a burst into one summary push", async () => {
    alreadyBackfilled();
    const likes = [1, 2, 3].map((i) => likeNotif({ uri: `at://did:plc:alice/app.bsky.feed.like/${i}` }));
    listNotifications.mockResolvedValue({ success: true, data: { notifications: likes, cursor: undefined } });

    const r = await syncBlueskyNotifications();
    expect(r.likes).toBe(3);
    expect(sendPushToOwner).toHaveBeenCalledTimes(1);
    expect(sendPushToOwner).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("3 new") }));
  });
});
