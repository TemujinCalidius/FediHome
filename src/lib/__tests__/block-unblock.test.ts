import { describe, it, expect, vi, beforeEach } from "vitest";

const { deliver, resolveInbox } = vi.hoisted(() => ({ deliver: vi.fn(), resolveInbox: vi.fn() }));
vi.mock("@/lib/http-signatures", () => ({ deliverActivity: deliver }));
vi.mock("@/lib/fedi-resolve", () => ({ resolveActorInbox: resolveInbox }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediFollowing: { findUnique: vi.fn(), delete: vi.fn() },
    fediFollower: { findUnique: vi.fn(), delete: vi.fn() },
    fediPost: { findFirst: vi.fn(), deleteMany: vi.fn() },
    fediInteraction: { deleteMany: vi.fn() },
    blockedActor: { upsert: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { block, unblock } from "@/app/api/admin/_actions/fedi-graph";
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
  vi.mocked(prisma.blockedActor.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.blockedActor.deleteMany).mockResolvedValue({ count: 1 } as never);
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
    // Still delivers the Block + purges content (existing behaviour).
    expect(deliver).toHaveBeenCalled();
    expect(prisma.fediPost.deleteMany).toHaveBeenCalledWith({ where: { actorUri: ACTOR } });
  });
});

describe("unblock() reverses it (#180)", () => {
  it("delivers Undo(Block) to the cached inbox and removes the row", async () => {
    vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(
      { actorUri: ACTOR, inbox: "https://x.social/inbox" } as never,
    );
    const res = await unblock({ actorUri: ACTOR } as never);
    expect(res.status).toBe(200);
    const activity = deliver.mock.calls[0][1] as { type: string; object: { type: string; object: string } };
    expect(activity.type).toBe("Undo");
    expect(activity.object.type).toBe("Block");
    expect(activity.object.object).toBe(ACTOR);
    expect(prisma.blockedActor.deleteMany).toHaveBeenCalledWith({ where: { actorUri: ACTOR } });
  });

  it("400 without an actorUri", async () => {
    expect((await unblock({} as never)).status).toBe(400);
    expect(prisma.blockedActor.deleteMany).not.toHaveBeenCalled();
  });
});
