import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Outbound block enforcement for Bluesky (#577).
 *
 * The fediverse twin of this file is `outbound-blocks.test.ts`, and the
 * difference between them is the whole bug. ActivityPub has a chokepoint:
 * `deliverActivity` refuses a blocked recipient before it signs anything, so one
 * gate covers follows, DMs, likes and replies — and a new outbound path inherits
 * it for free. Bluesky has none. Posts, likes, follows and chat messages each
 * leave through a different atproto method, so the gate has to be written out
 * once per surface, and four of the five were never written at all.
 *
 * #563 fixed likes and reposts. DMs, replies, follows and crossposted replies
 * kept going out unchecked until #577.
 *
 * EVERY TEST HERE USES A DOMAIN BLOCK, not a DID block. A DID block is the easy
 * half and always worked; the domain half is the one that silently collapses,
 * because `isBlueskyBlocked` derives its candidates from the HANDLE and a call
 * without one skips the `blockedDomain` query entirely. A test written with a
 * DID block passes against the bug it is meant to catch.
 *
 * And every test asserts the atproto method was NEVER INVOKED — not merely that
 * the caller got a refusal. #379's guarantee is zero network contact: a request
 * we make and then discard has already told them we are here.
 */

const { getBlueskyAgent, requireBlueskyAgent } = vi.hoisted(() => {
  const fn = vi.fn();
  return { getBlueskyAgent: fn, requireBlueskyAgent: fn };
});
vi.mock("@/lib/bluesky-agent", () => ({ getBlueskyAgent, requireBlueskyAgent }));

vi.mock("@/lib/db", () => ({
  prisma: {
    blockedActor: { findUnique: vi.fn() },
    blockedDomain: { findFirst: vi.fn() },
    fediPost: { findFirst: vi.fn() },
    blueskyFollowing: { findUnique: vi.fn(), upsert: vi.fn() },
    blueskyFollower: { findUnique: vi.fn() },
    directMessage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { bskyReply, bskyFollow } from "@/app/api/admin/_actions/bluesky";
import { bskyDm } from "@/app/api/admin/_actions/dms";
import { followBlueskyAccount } from "@/lib/bluesky-graph";
import { crosspostReplyToBluesky } from "@/lib/crosspost";

/** alice.spam.example — a handle whose DOMAIN is blockable, unlike a DID. */
const MALLORY_DID = "did:plc:mallory";
const MALLORY_HANDLE = "alice.spam.example";
const POST_URI = `at://${MALLORY_DID}/app.bsky.feed.post/1`;

const chatApi = {
  getConvoForMembers: vi.fn(),
  sendMessage: vi.fn(),
  getConvo: vi.fn(),
};

const agent = {
  session: { did: "did:plc:me", handle: "me.example" },
  post: vi.fn(),
  getPost: vi.fn(),
  follow: vi.fn(),
  getProfile: vi.fn(),
  resolveHandle: vi.fn(),
  withProxy: () => ({ api: { chat: { bsky: { convo: chatApi } } } }),
};

/** Exactly this domain is blocked. Nothing else. */
const blockDomain = (domain: string) =>
  vi.mocked(prisma.blockedDomain.findFirst).mockImplementation((async (a: {
    where: { domain: { in: string[] } };
  }) => (a.where.domain.in.includes(domain) ? { id: "d1" } : null)) as never);

/** Every outbound atproto method on the fake agent. */
const networkCalls = () => [
  ...agent.post.mock.calls,
  ...agent.getPost.mock.calls,
  ...agent.follow.mock.calls,
  ...agent.resolveHandle.mock.calls,
  ...chatApi.getConvoForMembers.mock.calls,
  ...chatApi.sendMessage.mock.calls,
];

beforeEach(() => {
  vi.clearAllMocks();
  getBlueskyAgent.mockResolvedValue(agent);

  // Nobody blocked, nothing known, until a test says otherwise.
  vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.blockedDomain.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.blueskyFollower.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.directMessage.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.directMessage.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.directMessage.create).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(prisma.blueskyFollowing.upsert).mockResolvedValue({} as never);

  // The handle lives on the stored post for reply surfaces, and on the graph
  // row for account surfaces — the two places we can learn it without asking
  // Bluesky about an account we may be about to refuse.
  vi.mocked(prisma.fediPost.findFirst).mockResolvedValue({ username: MALLORY_HANDLE } as never);
  vi.mocked(prisma.blueskyFollowing.findUnique).mockResolvedValue({ handle: MALLORY_HANDLE } as never);

  agent.getPost.mockResolvedValue({ uri: POST_URI, cid: "bafy", value: {} });
  agent.post.mockResolvedValue({ uri: "at://me/app.bsky.feed.post/2" });
  agent.follow.mockResolvedValue({ uri: "at://me/app.bsky.graph.follow/1" });
  agent.getProfile.mockResolvedValue({ data: { did: MALLORY_DID, handle: MALLORY_HANDLE } });
  agent.resolveHandle.mockResolvedValue({ data: { did: MALLORY_DID } });
  chatApi.getConvoForMembers.mockResolvedValue({ data: { convo: { id: "convo1" } } });
  chatApi.sendMessage.mockResolvedValue({ data: { id: "msg1" } });
  chatApi.getConvo.mockResolvedValue({
    data: { convo: { members: [{ did: "did:plc:me", handle: "me.example" }, { did: MALLORY_DID, handle: MALLORY_HANDLE }] } },
  });
});

describe("replying to a blocked account's post", () => {
  it("bskyReply refuses on a domain block, before it even fetches the parent", async () => {
    // A reply notifies the author — the same reason #563 gated likes. `getPost`
    // is a read from THEIR repo, so it counts as contact too.
    blockDomain("spam.example");
    const res = await bskyReply({ content: "hello", blueskyUri: POST_URI });
    expect(res.status).toBe(409);
    expect(networkCalls()).toEqual([]);
  });

  it("bskyReply goes through when nobody is blocked", async () => {
    const res = await bskyReply({ content: "hello", blueskyUri: POST_URI });
    expect(res.status).toBe(200);
    expect(agent.post).toHaveBeenCalled();
  });

  it("crosspostReplyToBluesky refuses on a domain block", async () => {
    // The gate sits in the library, not at the three callers — /api/compose, the
    // admin replies action, and the RETRY QUEUE. The queue is why: a reply
    // enqueued before a block would otherwise be delivered by a later sweep.
    blockDomain("spam.example");
    const res = await crosspostReplyToBluesky("hello", POST_URI);
    expect(res).toMatchObject({ success: false, error: "recipient is blocked" });
    expect(networkCalls()).toEqual([]);
  });

  it("crosspostReplyToBluesky posts when nobody is blocked", async () => {
    const res = await crosspostReplyToBluesky("hello", POST_URI);
    expect(res.success).toBe(true);
    expect(agent.post).toHaveBeenCalled();
  });
});

describe("following a blocked account", () => {
  it("followBlueskyAccount refuses on a domain block and never calls follow", async () => {
    // Gated in the library rather than in the route, so a second caller cannot
    // skip it — the same reason `deliverActivity` owns this on the fedi side.
    blockDomain("spam.example");
    const res = await followBlueskyAccount(MALLORY_DID);
    expect(res).toEqual({ ok: false, reason: "blocked" });
    expect(agent.follow).not.toHaveBeenCalled();
    expect(prisma.blueskyFollowing.upsert).not.toHaveBeenCalled();
  });

  it("uses the handle the operator typed, before resolving anything", async () => {
    // The typed address is the one case where we know the handle without asking
    // Bluesky, and a domain-based handle would be resolved via THEIR domain.
    vi.mocked(prisma.blueskyFollowing.findUnique).mockResolvedValue(null as never);
    blockDomain("spam.example");
    const res = await bskyFollow({ did: MALLORY_DID, handleOrDid: MALLORY_HANDLE });
    expect(res.status).toBe(409);
    expect(agent.follow).not.toHaveBeenCalled();
  });

  it("follows when nobody is blocked", async () => {
    const res = await followBlueskyAccount(MALLORY_DID);
    expect(res).toEqual({ ok: true });
    expect(agent.follow).toHaveBeenCalledWith(MALLORY_DID);
  });
});

describe("direct-messaging a blocked account", () => {
  it("refuses a new conversation by handle without resolving it", async () => {
    // resolveHandle for `alice.spam.example` is answered by spam.example, so the
    // domain half has to be settled BEFORE that, not after.
    blockDomain("spam.example");
    const res = await bskyDm({ content: "hi", recipientHandle: MALLORY_HANDLE });
    expect(res.status).toBe(409);
    expect(networkCalls()).toEqual([]);
  });

  it("refuses a new conversation by DID, using the handle we hold on file", async () => {
    blockDomain("spam.example");
    const res = await bskyDm({ content: "hi", recipientDid: MALLORY_DID });
    expect(res.status).toBe(409);
    // getConvoForMembers is not a read — it CREATES the conversation on their
    // side, so reaching it at all defeats the block.
    expect(chatApi.getConvoForMembers).not.toHaveBeenCalled();
    expect(chatApi.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a reply into an existing conversation", async () => {
    blockDomain("spam.example");
    const res = await bskyDm({ content: "hi", convoId: "convo1" });
    expect(res.status).toBe(409);
    expect(chatApi.sendMessage).not.toHaveBeenCalled();
  });

  it("checks EVERY member of a group conversation, not just the last writer", async () => {
    // The stored rows only name people who have written to us, so a quiet
    // blocked member of a group chat would pass a check built on them alone.
    chatApi.getConvo.mockResolvedValue({
      data: {
        convo: {
          members: [
            { did: "did:plc:me", handle: "me.example" },
            { did: "did:plc:ada", handle: "ada.example" },
            { did: MALLORY_DID, handle: MALLORY_HANDLE },
          ],
        },
      },
    });
    blockDomain("spam.example");
    const res = await bskyDm({ content: "hi", convoId: "convo1" });
    expect(res.status).toBe(409);
    expect(chatApi.sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to stored messages when the convo can't be read", async () => {
    chatApi.getConvo.mockRejectedValue(new Error("chat service down"));
    vi.mocked(prisma.directMessage.findMany).mockResolvedValue([
      { senderUri: MALLORY_DID, senderHandle: MALLORY_HANDLE },
    ] as never);
    blockDomain("spam.example");
    const res = await bskyDm({ content: "hi", convoId: "convo1" });
    expect(res.status).toBe(409);
    expect(chatApi.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses rather than guesses when nobody can say who the conversation is with", async () => {
    // Not a 409 — we are not claiming they are blocked, only that we cannot
    // tell. A DM is never urgent enough to send to an unidentified recipient.
    chatApi.getConvo.mockRejectedValue(new Error("chat service down"));
    const res = await bskyDm({ content: "hi", convoId: "convo1" });
    expect(res.status).toBe(502);
    expect(chatApi.sendMessage).not.toHaveBeenCalled();
  });

  it("sends when nobody in the conversation is blocked", async () => {
    const res = await bskyDm({ content: "hi", convoId: "convo1" });
    expect(res.status).toBe(200);
    expect(chatApi.sendMessage).toHaveBeenCalledWith({
      convoId: "convo1",
      message: { text: "hi" },
    });
  });

  it("starts a new conversation when nobody is blocked", async () => {
    const res = await bskyDm({ content: "hi", recipientDid: MALLORY_DID });
    expect(res.status).toBe(200);
    expect(chatApi.getConvoForMembers).toHaveBeenCalledWith({ members: [MALLORY_DID] });
    expect(chatApi.sendMessage).toHaveBeenCalled();
  });
});
