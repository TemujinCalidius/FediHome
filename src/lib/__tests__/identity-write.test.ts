import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Writing federation identity, and refusing to (#326).
 *
 * `identity.*` has been readable from the database since Phase 1, but nothing
 * wrote it — an instance could only be addressed by editing `.env.local` on the
 * host, which is precisely what makes it impossible to stand one up without
 * shell access.
 *
 * The interesting half is the refusal. `Post`/`Photo`/`Video`/`Audio`/
 * `DirectMessage` `.apId` are `@unique` ABSOLUTE URLs built from `SITE_URL`, and
 * remote servers keep the first actor id they ever saw. So the moment anything
 * is published, changing the address orphans it rather than moves it — and the
 * copies that matter are on other people's servers, where we can't rewrite
 * anything. That's what `identityIsLocked()` is protecting, and the tests below
 * exist to make sure a future refactor doesn't quietly loosen it.
 */

const counts = vi.hoisted(() => ({
  post: vi.fn(),
  photo: vi.fn(),
  video: vi.fn(),
  audio: vi.fn(),
  directMessage: vi.fn(),
  fediPost: vi.fn(),
  fediFollower: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    post: { count: counts.post },
    photo: { count: counts.photo },
    video: { count: counts.video },
    audio: { count: counts.audio },
    directMessage: { count: counts.directMessage },
    fediPost: { count: counts.fediPost },
    fediFollower: { count: counts.fediFollower },
    siteSetting: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

import { identityIsLocked, setIdentity } from "@/lib/identity-store";
import { prisma } from "@/lib/db";

const allZero = () => Object.values(counts).forEach((c) => c.mockResolvedValue(0));

beforeEach(() => {
  vi.clearAllMocks();
  allZero();
  vi.mocked(prisma.siteSetting.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.siteSetting.deleteMany).mockResolvedValue({ count: 1 } as never);
});

describe("identityIsLocked", () => {
  it("is unlocked on an instance that has published nothing", async () => {
    expect(await identityIsLocked()).toEqual({ locked: false });
  });

  it.each([
    ["a post", "post"],
    ["a photo", "photo"],
    ["a video", "video"],
    ["an audio item", "audio"],
    ["an outgoing DM", "directMessage"],
    ["an outgoing fedi post", "fediPost"],
  ])("locks once there is %s", async (_label, model) => {
    counts[model as keyof typeof counts].mockResolvedValue(1);
    const r = await identityIsLocked();
    expect(r.locked).toBe(true);
    expect(r.reason).toMatch(/published/i);
  });

  it("locks when someone follows you, even with nothing published", async () => {
    // Their follow points at the current actor id. Changing it breaks them
    // silently — no error on either side, the posts just stop.
    counts.fediFollower.mockResolvedValue(2);
    const r = await identityIsLocked();
    expect(r.locked).toBe(true);
    expect(r.reason).toMatch(/follow/i);
  });

  it("locks when it cannot prove the instance is empty", async () => {
    // Fail closed: an identity change that turns out to have been unsafe cannot
    // be undone, because other servers have already cached the old id.
    counts.post.mockRejectedValue(new Error("db down"));
    expect((await identityIsLocked()).locked).toBe(true);
  });

  it("checks every model that carries an absolute apId", async () => {
    // If a new content type gains an apId and isn't counted here, an instance
    // holding one would read as unlocked and its content would be orphaned.
    await identityIsLocked();
    for (const [name, fn] of Object.entries(counts)) {
      expect(fn, `${name}.count was never called`).toHaveBeenCalled();
    }
  });

  it("only counts OUTGOING DMs and fedi posts", async () => {
    // Inbound ones carry the sender's identity, not ours, so they don't lock
    // anything — and counting them would make an instance that merely received
    // a message permanently unaddressable.
    await identityIsLocked();
    expect(counts.directMessage.mock.calls[0][0]).toEqual({ where: { isOutgoing: true } });
    expect(counts.fediPost.mock.calls[0][0]).toEqual({ where: { isOutgoing: true } });
  });
});

describe("setIdentity", () => {
  it("writes only the fields given", async () => {
    await setIdentity({ fediHandle: "sam" });
    expect(prisma.siteSetting.upsert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.siteSetting.upsert).mock.calls[0][0].where).toEqual({ key: "identity.fediHandle" });
  });

  it("writes all three when all three are given", async () => {
    await setIdentity({ siteUrl: "https://a.example", fediHandle: "sam", fediDomain: "a.example" });
    const keys = vi.mocked(prisma.siteSetting.upsert).mock.calls.map((c) => c[0].where);
    expect(keys).toEqual([
      { key: "identity.siteUrl" },
      { key: "identity.fediHandle" },
      { key: "identity.fediDomain" },
    ]);
  });

  it("an empty string clears the row back to the environment value", async () => {
    await setIdentity({ siteUrl: "" });
    expect(prisma.siteSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "identity.siteUrl" } });
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalled();
  });

  it("refuses a value containing whitespace, which would corrupt the actor id", async () => {
    await expect(setIdentity({ siteUrl: "https://a.example /x" })).rejects.toThrow();
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalled();
  });
});
