import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * `blockDomain` — the destructive half of a server block.
 *
 * It deletes every post, interaction and relationship from a host, so the two
 * things that must hold are that it refuses obvious mistakes (above all
 * blocking your OWN domain, which would silently drop your own federated
 * traffic) and that it leaves the cached like/boost counters consistent, the
 * same way an actor block now does.
 */

const { deliver } = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/lib/http-signatures", () => ({ deliverActivity: deliver }));
vi.mock("@/lib/fedi-resolve", () => ({ resolveActorInbox: vi.fn() }));
vi.mock("@/lib/url-guard", () => ({
  assertPublicHost: vi.fn(async () => true),
  isPrivateUrl: vi.fn(() => false),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    blockedDomain: { upsert: vi.fn(), deleteMany: vi.fn() },
    blockedActor: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    fediPost: { findMany: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn() },
    fediInteraction: { findMany: vi.fn(), deleteMany: vi.fn() },
    fediFollower: { deleteMany: vi.fn(), findUnique: vi.fn() },
    fediFollowing: { deleteMany: vi.fn(), findUnique: vi.fn() },
    failedDelivery: { findMany: vi.fn(), deleteMany: vi.fn() },
    post: { updateMany: vi.fn() },
    photo: { updateMany: vi.fn() },
  },
}));

import { blockDomain, unblockDomain } from "@/app/api/admin/_actions/fedi-graph";
import { prisma } from "@/lib/db";

const OLD_ENV = { SITE_URL: process.env.SITE_URL, FEDI_DOMAIN: process.env.FEDI_DOMAIN };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  process.env.FEDI_DOMAIN = "demo.example";
  vi.mocked(prisma.blockedDomain.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.blockedDomain.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.fediPost.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.fediPost.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.fediInteraction.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.fediInteraction.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.fediFollower.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.fediFollowing.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.post.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.photo.updateMany).mockResolvedValue({ count: 0 } as never);
});

afterAll(() => {
  for (const [k, v] of Object.entries(OLD_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("blockDomain refuses mistakes", () => {
  it("refuses this site's own domain", async () => {
    // Blocking yourself would drop your own federated traffic, and nothing in
    // the UI would explain why everything went quiet.
    const res = await blockDomain({ domain: "demo.example" } as never);
    expect(res.status).toBe(400);
    expect(prisma.blockedDomain.upsert).not.toHaveBeenCalled();
  });

  it("refuses your own domain however it's typed", async () => {
    expect((await blockDomain({ domain: "DEMO.example:443" } as never)).status).toBe(400);
    expect((await blockDomain({ domain: "https://demo.example/users/me" } as never)).status).toBe(400);
    expect(prisma.blockedDomain.upsert).not.toHaveBeenCalled();
  });

  it("refuses something that isn't a domain", async () => {
    for (const bad of ["", "   ", "localhost", "not a domain"]) {
      expect((await blockDomain({ domain: bad } as never)).status).toBe(400);
    }
    expect(prisma.blockedDomain.upsert).not.toHaveBeenCalled();
  });
});

describe("blockDomain purges what the server already sent", () => {
  it("stores the normalised domain and deletes their content and relationships", async () => {
    const res = await blockDomain({ domain: "  Spam.Example  ", reason: "spam" } as never);
    expect(res.status).toBe(200);

    expect(prisma.blockedDomain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domain: "spam.example" } }),
    );
    expect(prisma.fediInteraction.deleteMany).toHaveBeenCalled();
    expect(prisma.fediFollower.deleteMany).toHaveBeenCalled();
    expect(prisma.fediFollowing.deleteMany).toHaveBeenCalled();
  });

  it("matches subdomains as well as the domain itself", async () => {
    await blockDomain({ domain: "spam.example" } as never);
    const where = vi.mocked(prisma.fediInteraction.deleteMany).mock.calls[0][0]?.where;
    expect(JSON.stringify(where)).toContain(".spam.example"); // the endsWith arm
    expect(JSON.stringify(where)).toContain("spam.example");
  });

  it("takes the cached counters down with the purged interactions", async () => {
    vi.mocked(prisma.fediInteraction.findMany).mockResolvedValue([
      { type: "like", targetApId: "https://demo.example/post/a" },
      { type: "boost", targetApId: "https://demo.example/post/b" },
    ] as never);

    await blockDomain({ domain: "spam.example" } as never);

    expect(prisma.post.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { likeCount: { decrement: 1 } } }),
    );
    expect(prisma.post.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { boostCount: { decrement: 1 } } }),
    );
  });

  it("never federates anything — the server isn't told", async () => {
    await blockDomain({ domain: "spam.example" } as never);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("unblockDomain", () => {
  it("removes the row by normalised domain", async () => {
    const res = await unblockDomain({ domain: "Spam.Example" } as never);
    expect(res.status).toBe(200);
    expect(prisma.blockedDomain.deleteMany).toHaveBeenCalledWith({
      where: { domain: "spam.example" },
    });
  });

  it("400s without a domain", async () => {
    expect((await unblockDomain({} as never)).status).toBe(400);
  });
});

describe("queued retries aimed at the blocked instance are dropped (#379)", () => {
  beforeEach(() => {
    vi.mocked(prisma.failedDelivery.deleteMany).mockResolvedValue({ count: 1 } as never);
  });

  it("drops pending rows on the domain and its subdomains, and nothing else", async () => {
    // block()/blockDomain() delete the relationship rows, which stops future
    // fan-out — but a row queued BEFORE the block survived, and the sweep kept
    // re-delivering it with backoff to the blocked inbox for ~31 hours.
    vi.mocked(prisma.failedDelivery.findMany).mockResolvedValue([
      { id: "r1", inbox: "https://spam.example/inbox" },
      { id: "r2", inbox: "https://a.spam.example/inbox" },
      { id: "r3", inbox: "https://good.example/inbox" },
    ] as never);

    await blockDomain({ domain: "spam.example" } as never);

    // Only pending rows are considered — a terminal one is already inert.
    expect(vi.mocked(prisma.failedDelivery.findMany).mock.calls[0][0]).toMatchObject({
      where: { failedAt: null },
    });
    expect(prisma.failedDelivery.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["r1", "r2"] } } });
  });

  it("touches nothing when no queued row points at the domain", async () => {
    vi.mocked(prisma.failedDelivery.findMany).mockResolvedValue([
      { id: "r3", inbox: "https://good.example/inbox" },
    ] as never);
    await blockDomain({ domain: "spam.example" } as never);
    expect(prisma.failedDelivery.deleteMany).not.toHaveBeenCalled();
  });
});

