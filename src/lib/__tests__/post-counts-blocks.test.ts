import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * #559, and this one is a different class from the other three.
 *
 * `/api/fedi-post-counts` had no block check of any kind. Past its five-minute
 * cache it makes a `guardedFetch` and then a `signedGet` to the post's own
 * origin — so for a blocked actor's post it was OUTBOUND CONTACT WITH A BLOCKED
 * SERVER, which is what #379 exists to prevent, rather than merely showing the
 * owner something they'd hidden.
 *
 * The assertion that matters here is therefore about what is SENT, not what is
 * returned. A fix that filtered the response but still made the request would
 * pass a display test and leave the leak untouched.
 */

const { authenticateApiRequest, verifyOrigin } = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  verifyOrigin: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest, verifyOrigin }));
const { signedGet } = vi.hoisted(() => ({ signedGet: vi.fn() }));
vi.mock("@/lib/http-signatures", () => ({ signedGet }));
const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ guardedFetch, GuardedFetchError: class extends Error {} }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediPost: { findUnique: vi.fn(), update: vi.fn() },
    blockedActor: { findMany: vi.fn() },
    blockedDomain: { findMany: vi.fn() },
  },
}));

import { POST } from "@/app/api/fedi-post-counts/route";
import { prisma } from "@/lib/db";

const MALLORY = "https://spam.example/users/mallory";

const req = (postId: string): NextRequest =>
  ({
    json: async () => ({ postId }),
    headers: new Headers(),
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  authenticateApiRequest.mockResolvedValue({ ok: true });
  verifyOrigin.mockReturnValue(true);
  vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([{ actorUri: MALLORY }] as never);
  vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([] as never);
  // Stale, so the route would otherwise go to the network.
  vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({
    id: "p1",
    apId: "https://spam.example/notes/1",
    actorUri: MALLORY,
    likeCount: 5,
    boostCount: 2,
    replyCount: 1,
    countsFetchedAt: new Date(Date.now() - 60 * 60 * 1000),
  } as never);
});

describe("#559 — counts for a blocked actor's post", () => {
  it("never contacts the blocked server", async () => {
    // THE assertion. #379's property: a blocked instance must not learn we
    // looked. A display-only fix would leave both of these called.
    await POST(req("p1"));
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(signedGet).not.toHaveBeenCalled();
  });

  it("404s, the same as a post that isn't there", async () => {
    expect((await POST(req("p1"))).status).toBe(404);
  });

  it("refuses even when the cached counts are fresh", async () => {
    // Checked ABOVE the cache branch on purpose — otherwise a stale-but-fresh
    // row keeps serving a blocked post's counts indefinitely.
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({
      id: "p1",
      apId: "https://spam.example/notes/1",
      actorUri: MALLORY,
      likeCount: 5,
      boostCount: 2,
      replyCount: 1,
      countsFetchedAt: new Date(),
    } as never);
    expect((await POST(req("p1"))).status).toBe(404);
  });

  it("still serves counts for someone who isn't blocked", async () => {
    vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({
      id: "p2",
      apId: "https://mastodon.example/notes/9",
      actorUri: "https://mastodon.example/users/ada",
      likeCount: 3,
      boostCount: 1,
      replyCount: 0,
      countsFetchedAt: new Date(),
    } as never);
    const body = await (await POST(req("p2"))).json();
    expect(body.likeCount).toBe(3);
  });
});
