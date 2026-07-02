import { describe, it, expect, vi, beforeEach } from "vitest";

const { deliver, deliverFollowers } = vi.hoisted(() => ({ deliver: vi.fn(), deliverFollowers: vi.fn() }));
vi.mock("@/lib/http-signatures", () => ({ deliverActivity: deliver, deliverToFollowers: deliverFollowers }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediPost: { findUnique: vi.fn(), updateMany: vi.fn() },
    fediFollower: { findUnique: vi.fn() },
  },
}));

import { like, boost } from "@/app/api/admin/_actions/fedi-interactions";
import { originalApId } from "@/lib/fedi-resolve";
import { prisma } from "@/lib/db";

const ORIGINAL = "https://orig.example/note/1";
const BOOST = `boost:https://booster.example/users/x:${ORIGINAL}`;

beforeEach(() => {
  vi.clearAllMocks();
  deliver.mockResolvedValue(undefined);
  deliverFollowers.mockResolvedValue(undefined);
  // resolveTarget: boost row → original author's actorUri → (a follower) inbox,
  // so no network resolveActorInbox call is needed.
  vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({ actorUri: "https://orig.example/actor" } as never);
  vi.mocked(prisma.fediFollower.findUnique).mockResolvedValue(
    { inbox: "https://orig.example/inbox", sharedInbox: null } as never,
  );
  vi.mocked(prisma.fediPost.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe("originalApId", () => {
  it("strips the boost: prefix down to the original URL", () => {
    expect(originalApId(BOOST)).toBe(ORIGINAL);
  });
  it("passes a normal apId through unchanged", () => {
    expect(originalApId("https://x.example/note/9")).toBe("https://x.example/note/9");
  });
  it("passes a non-URL / malformed value through unchanged", () => {
    expect(originalApId("boost:whatever")).toBe("boost:whatever");
  });
});

describe("like() on a boosted post (#174)", () => {
  it("federates the ORIGINAL post URL as the object but persists on the row apId", async () => {
    await like({ postApId: BOOST, targetInbox: "https://ignored/inbox" } as never);
    expect(deliver).toHaveBeenCalledTimes(1);
    const activity = deliver.mock.calls[0][1] as { object: string };
    expect(activity.object).toBe(ORIGINAL); // real URL, not the boost: string
    expect(prisma.fediPost.updateMany).toHaveBeenCalledWith({
      where: { apId: BOOST }, // persistence still keyed on the row apId
      data: { likedByMe: true },
    });
  });
});

describe("boost() on a boosted post (#174)", () => {
  it("announces the ORIGINAL post URL", async () => {
    await boost({ postApId: BOOST } as never);
    const announce = deliverFollowers.mock.calls[0][0] as { object: string };
    expect(announce.object).toBe(ORIGINAL);
    expect(prisma.fediPost.updateMany).toHaveBeenCalledWith({
      where: { apId: BOOST },
      data: { boostedByMe: true },
    });
  });
});
