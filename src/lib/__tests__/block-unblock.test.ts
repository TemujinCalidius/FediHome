import { describe, it, expect, vi, beforeEach } from "vitest";

const { deliver, resolveInbox } = vi.hoisted(() => ({ deliver: vi.fn(), resolveInbox: vi.fn() }));
vi.mock("@/lib/http-signatures", () => ({ deliverActivity: deliver }));
vi.mock("@/lib/fedi-resolve", () => ({ resolveActorInbox: resolveInbox }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost: vi.fn(async () => true), isPrivateUrl: vi.fn(() => false) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediFollowing: { findUnique: vi.fn(), delete: vi.fn(), upsert: vi.fn(), count: vi.fn() },
    fediFollower: { findUnique: vi.fn(), delete: vi.fn(), count: vi.fn() },
    fediPost: { findFirst: vi.fn(), deleteMany: vi.fn() },
    fediInteraction: { deleteMany: vi.fn(), findMany: vi.fn() },
    blockedActor: { upsert: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
    blockedDomain: { findFirst: vi.fn() },
    failedDelivery: { findMany: vi.fn(), deleteMany: vi.fn() },
    post: { updateMany: vi.fn() },
    photo: { updateMany: vi.fn() },
  },
}));

import { block, unblock, follow } from "@/app/api/admin/_actions/fedi-graph";
import { prisma } from "@/lib/db";

const ACTOR = "https://x.social/users/bob";

beforeEach(() => {
  vi.clearAllMocks();
  deliver.mockResolvedValue(undefined);
  resolveInbox.mockResolvedValue(null);
  vi.mocked(prisma.fediFollowing.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.fediFollower.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.fediPost.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.fediPost.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.fediInteraction.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.fediInteraction.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.post.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.photo.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.blockedActor.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.blockedActor.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.blockedDomain.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.failedDelivery.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.failedDelivery.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.fediFollowing.upsert).mockResolvedValue({} as never);
});

describe("block() records the block (#180)", () => {
  it("upserts a BlockedActor row with handle + inbox from the follower record", async () => {
    vi.mocked(prisma.fediFollower.findUnique).mockResolvedValue({
      inbox: "https://x.social/inbox", username: "bob", domain: "x.social",
      displayName: "Bob", avatarUrl: "https://x.social/a.png",
    } as never);
    vi.mocked(prisma.fediFollower.delete).mockResolvedValue({} as never);

    const res = await block({ actorUri: ACTOR } as never);
    expect(res.status).toBe(200);
    expect(prisma.blockedActor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { actorUri: ACTOR },
        create: expect.objectContaining({
          actorUri: ACTOR,
          handle: "@bob@x.social",
          displayName: "Bob",
          inbox: "https://x.social/inbox",
        }),
      }),
    );
    // Content is still purged...
    expect(prisma.fediPost.deleteMany).toHaveBeenCalledWith({ where: { actorUri: ACTOR } });
    expect(prisma.fediInteraction.deleteMany).toHaveBeenCalledWith({ where: { actorUri: ACTOR } });
    // ...and the follower row dropped.
    expect(prisma.fediFollower.delete).toHaveBeenCalledWith({ where: { actorUri: ACTOR } });
    // ...but NO Block activity is federated. ActivityPub says a server SHOULD
    // NOT deliver Block to its object; sending it is what lets a blocked person
    // on Mastodon detect the block. Enforcement is local (lib/blocks.ts).
    expect(deliver).not.toHaveBeenCalled();
  });

  it("still sends Undo(Follow) when we were following them", async () => {
    // Ending our own follow is between us and their server, and it has to be
    // federated or we keep receiving their posts.
    vi.mocked(prisma.fediFollowing.findUnique).mockResolvedValue(
      { actorUri: ACTOR, inbox: "https://x.social/inbox" } as never,
    );
    vi.mocked(prisma.fediFollowing.delete).mockResolvedValue({} as never);

    await block({ actorUri: ACTOR } as never);

    const kinds = deliver.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(kinds).toContain("Undo");
    expect(kinds).not.toContain("Block");
  });
});

describe("unblock() reverses it (#180)", () => {
  it("removes the row and federates nothing", async () => {
    vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(
      { actorUri: ACTOR, inbox: "https://x.social/inbox" } as never,
    );
    const res = await unblock({ actorUri: ACTOR } as never);
    expect(res.status).toBe(200);
    expect(prisma.blockedActor.deleteMany).toHaveBeenCalledWith({ where: { actorUri: ACTOR } });
    // No Undo(Block), because no Block was ever sent — and announcing "you were
    // blocked, and now you aren't" is the disclosure we're avoiding.
    expect(deliver).not.toHaveBeenCalled();
  });

  it("400 without an actorUri", async () => {
    expect((await unblock({} as never)).status).toBe(400);
    expect(prisma.blockedActor.deleteMany).not.toHaveBeenCalled();
  });
});

describe("block() takes the cached counters down with the interactions", () => {
  it("decrements likeCount and boostCount for each purged interaction", async () => {
    // Deleting FediInteraction rows alone leaves the number wrong — a post
    // reading "3 likes" while showing two faces. It can't self-correct either:
    // an Undo(Like) from a blocked actor is now dropped at the inbox, so nothing
    // will ever decrement it.
    vi.mocked(prisma.fediInteraction.findMany).mockResolvedValue([
      { type: "like", targetApId: "https://demo.example/post/a" },
      { type: "boost", targetApId: "https://demo.example/post/b" },
    ] as never);

    await block({ actorUri: ACTOR } as never);

    expect(prisma.post.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ apId: "https://demo.example/post/a" }),
        data: { likeCount: { decrement: 1 } },
      }),
    );
    expect(prisma.post.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ apId: "https://demo.example/post/b" }),
        data: { boostCount: { decrement: 1 } },
      }),
    );
  });

  it("never drives a counter below zero", async () => {
    vi.mocked(prisma.fediInteraction.findMany).mockResolvedValue([
      { type: "like", targetApId: "https://demo.example/post/a" },
    ] as never);

    await block({ actorUri: ACTOR } as never);

    // The gt:0 guard is what stops an already-out-of-step counter going negative.
    expect(prisma.post.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ likeCount: { gt: 0 } }) }),
    );
  });

  it("reads the interactions BEFORE deleting them", async () => {
    const order: string[] = [];
    vi.mocked(prisma.fediInteraction.findMany).mockImplementation((async () => {
      order.push("read");
      return [];
    }) as never);
    vi.mocked(prisma.fediInteraction.deleteMany).mockImplementation((async () => {
      order.push("delete");
      return { count: 0 };
    }) as never);

    await block({ actorUri: ACTOR } as never);
    expect(order).toEqual(["read", "delete"]);
  });
});

describe("follow() refuses a blocked account", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: ACTOR, preferredUsername: "bob", inbox: `${ACTOR}/inbox` }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
  });

  it("409s on follow-by-URI without importing anything", async () => {
    // Otherwise the outbox backfill re-imports up to 10 of their posts while the
    // block is still in place — the block list says blocked, the inbox drops
    // everything they send, and their content is on screen anyway.
    vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue({ id: "b1" } as never);
    const res = await follow({ actorUri: ACTOR } as never);
    expect(res.status).toBe(409);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("also refuses when reached by HANDLE, not just by URI", async () => {
    // The by-URI guard runs early; the handle path only learns the real actor
    // URI from WebFinger, so it needs its own check — or a blocked account could
    // be followed simply by typing their @handle.
    vi.mocked(prisma.blockedActor.findUnique).mockImplementation(
      (async ({ where }: { where: { actorUri: string } }) =>
        where.actorUri === ACTOR ? { id: "b1" } : null) as never,
    );
    global.fetch = vi.fn(async (url: unknown) =>
      String(url).includes("webfinger")
        ? new Response(
            JSON.stringify({ links: [{ rel: "self", type: "application/activity+json", href: ACTOR }] }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ id: ACTOR, inbox: `${ACTOR}/inbox` }), { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await follow({ handle: "@bob@x.social" } as never);
    expect(res.status).toBe(409);
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });

  it("still follows a non-blocked account normally", async () => {
    vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(null as never);
    const res = await follow({ actorUri: ACTOR } as never);
    expect(res.status).toBe(200);
  });
});

describe("follow() refuses a blocked DOMAIN, with zero network contact (#379)", () => {
  beforeEach(() => {
    vi.mocked(prisma.blockedDomain.findFirst).mockImplementation((async (a: { where: { domain: { in: string[] } } }) =>
      a.where.domain.in.includes("spam.example") ? { id: "d1" } : null) as never);
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  it("409s on a HANDLE at a blocked instance without WebFingering it", async () => {
    // The handle path had no early check at all: with the instance domain-blocked
    // you could still follow anyone there by typing their handle, and we would
    // WebFinger them, fetch their profile, backfill ten posts, and deliver a
    // signed Follow. The point of the block is to make no contact whatsoever.
    const res = await follow({ handle: "@mallory@spam.example" } as never);
    expect(res.status).toBe(409);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });

  it("409s on a direct actor URI at a blocked instance, before DNS resolution", async () => {
    const res = await follow({ actorUri: "https://spam.example/users/mallory" } as never);
    expect(res.status).toBe(409);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("covers subdomains of a blocked instance", async () => {
    expect((await follow({ handle: "@x@a.spam.example" } as never)).status).toBe(409);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails CLOSED with a 503 when the block list is unreadable", async () => {
    // Proceeding would mean contacting a host we may well have blocked.
    vi.mocked(prisma.blockedDomain.findFirst).mockRejectedValue(new Error("db down") as never);
    const res = await follow({ actorUri: "https://good.example/users/ada" } as never);
    expect(res.status).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("block() purges queued retries only when the inbox isn't shared (#379)", () => {
  beforeEach(() => {
    vi.mocked(prisma.fediFollowing.findUnique).mockResolvedValue(
      { actorUri: ACTOR, inbox: "https://mastodon.example/users/mallory/inbox" } as never,
    );
    vi.mocked(prisma.fediFollowing.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.failedDelivery.deleteMany).mockResolvedValue({ count: 1 } as never);
  });

  it("purges when no one else is behind that inbox", async () => {
    vi.mocked(prisma.fediFollower.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.fediFollowing.count).mockResolvedValue(0 as never);
    await block({ actorUri: ACTOR } as never);
    expect(prisma.failedDelivery.deleteMany).toHaveBeenCalledWith({
      where: { inbox: "https://mastodon.example/users/mallory/inbox" },
    });
  });

  it("leaves the queue alone when the inbox is SHARED", async () => {
    // Deleting by inbox alone would cancel queued posts to every unrelated
    // account behind, say, https://mastodon.social/inbox.
    vi.mocked(prisma.fediFollower.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.fediFollowing.count).mockResolvedValue(0 as never);
    await block({ actorUri: ACTOR } as never);
    expect(prisma.failedDelivery.deleteMany).not.toHaveBeenCalled();
  });
});

