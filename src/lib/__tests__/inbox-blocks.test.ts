import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Inbox block enforcement.
 *
 * The bug: `block()` purged the actor's cached content and dropped the follow,
 * but nothing ever consulted `BlockedActor` again — so a blocked account could
 * re-follow, re-like and reply the next second and it was stored and
 * push-notified as normal. Block was a one-shot purge, not a block.
 *
 * The other half of the contract is that a block must stay *invisible*: a
 * blocked sender gets exactly the same 202 as anyone else, so their server sees
 * a perfectly normal delivery.
 */

const { verifyIncomingSignature, actorMatchesSigner, deliverActivity, processAttachments, fetchLinkEmbed, sendPushToOwner } =
  vi.hoisted(() => ({
    verifyIncomingSignature: vi.fn(),
    actorMatchesSigner: vi.fn(),
    deliverActivity: vi.fn(),
    processAttachments: vi.fn(),
    fetchLinkEmbed: vi.fn(),
    sendPushToOwner: vi.fn(),
  }));
vi.mock("@/lib/http-signatures", () => ({ verifyIncomingSignature, actorMatchesSigner, deliverActivity }));
vi.mock("@/lib/fedi-media", () => ({ processAttachments, fetchLinkEmbed }));
vi.mock("@/lib/push", () => ({ sendPushToOwner }));
vi.mock("@/lib/notifications", () => ({ resolveOwnedTarget: vi.fn() }));
const { assertPublicHost } = vi.hoisted(() => ({ assertPublicHost: vi.fn() }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost }));
vi.mock("@/lib/db", () => ({
  prisma: {
    blockedActor: { findUnique: vi.fn() },
    fediPost: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    fediInteraction: { updateMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    fediFollowing: { findUnique: vi.fn() },
    fediFollower: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), create: vi.fn(), delete: vi.fn() },
    post: { findFirst: vi.fn() },
    photo: { findFirst: vi.fn() },
    directMessage: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { POST } from "@/app/ap/inbox/route";
import { prisma } from "@/lib/db";

const BLOCKED = "https://mastodon.example/users/mallory";
const ALLOWED = "https://mastodon.example/users/ada";
// A FediHome actor: its path is /ap/actor, NOT /users/<name>. This is the shape
// the old client-side URI synthesis got wrong.
const FEDIHOME_ACTOR = "https://friend.example/ap/actor";

const req = (activity: Record<string, unknown>): NextRequest =>
  new Request("https://demo.example/ap/inbox", {
    method: "POST",
    headers: { "content-type": "application/activity+json" },
    body: JSON.stringify(activity),
  }) as unknown as NextRequest;

/** Every activity type a blocked actor might use to get back in. */
const activities = (actor: string) => [
  { label: "Follow", body: { type: "Follow", actor, id: `${actor}#f1`, object: "https://demo.example/ap/actor" } },
  { label: "Like", body: { type: "Like", actor, object: "https://demo.example/post/x" } },
  { label: "Announce", body: { type: "Announce", actor, object: "https://demo.example/post/x" } },
  {
    label: "Create(Note)",
    body: { type: "Create", actor, object: { type: "Note", id: `${actor}/statuses/1`, content: "<p>hi</p>" } },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  verifyIncomingSignature.mockImplementation(async (_r: unknown, raw: string) => ({
    valid: true,
    actorUri: (JSON.parse(raw) as { actor: string }).actor,
  }));
  actorMatchesSigner.mockReturnValue(true);
  // Let the real handler path run for non-blocked actors: fetchActorInfo needs
  // both the SSRF guard to pass and an actor document to come back.
  assertPublicHost.mockResolvedValue(true);
  global.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        id: ALLOWED,
        preferredUsername: "ada",
        name: "Ada",
        inbox: "https://mastodon.example/users/ada/inbox",
      }),
      { status: 200, headers: { "content-type": "application/activity+json" } },
    ),
  ) as unknown as typeof fetch;
  processAttachments.mockResolvedValue({ urls: [], types: [] });
  fetchLinkEmbed.mockResolvedValue(null);
  sendPushToOwner.mockResolvedValue(undefined); // callers do `.catch()` on it
  deliverActivity.mockResolvedValue({ ok: true, status: 202 });
  vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.fediPost.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.fediInteraction.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.fediFollower.findUnique).mockResolvedValue(null);
  // Only BLOCKED and the FediHome-shaped actor are on the blocklist.
  vi.mocked(prisma.blockedActor.findUnique).mockImplementation(
    (async ({ where }: { where: { actorUri: string } }) =>
      where.actorUri === BLOCKED || where.actorUri === FEDIHOME_ACTOR ? { id: "b1" } : null) as never,
  );
});

describe("a blocked actor cannot get back in", () => {
  for (const { label, body } of activities(BLOCKED)) {
    it(`drops ${label} without storing or notifying`, async () => {
      const res = await POST(req(body));

      // Same 202 as a normal delivery — the block must not be detectable.
      expect(res.status).toBe(202);
      expect(sendPushToOwner).not.toHaveBeenCalled();
      expect(prisma.fediPost.upsert).not.toHaveBeenCalled();
      expect(prisma.fediInteraction.create).not.toHaveBeenCalled();
      expect(prisma.fediFollower.upsert).not.toHaveBeenCalled();
      expect(prisma.fediFollower.create).not.toHaveBeenCalled();
      // A Follow from a blocked actor must not be auto-accepted back.
      expect(deliverActivity).not.toHaveBeenCalled();
      // The handler never even started: fetchActorInfo is its first step.
      expect(assertPublicHost).not.toHaveBeenCalled();
    });
  }

  it("blocks a FediHome-shaped actor (/ap/actor), not just Mastodon-shaped ones", async () => {
    const res = await POST(req({ type: "Like", actor: FEDIHOME_ACTOR, object: "https://demo.example/post/x" }));
    expect(res.status).toBe(202);
    expect(prisma.fediInteraction.create).not.toHaveBeenCalled();
  });

  it("checks the blocklist by exact actor URI", async () => {
    await POST(req({ type: "Like", actor: BLOCKED, object: "https://demo.example/post/x" }));
    expect(prisma.blockedActor.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { actorUri: BLOCKED } }),
    );
  });
});

describe("everyone else is unaffected", () => {
  it("lets a normal Follow through to the handler", async () => {
    const res = await POST(req({ type: "Follow", actor: ALLOWED, id: `${ALLOWED}#f1`, object: "https://demo.example/ap/actor" }));
    expect(res.status).toBe(202);
    // handleFollow ran: it upserts the follower and sends an Accept.
    expect(prisma.fediFollower.upsert).toHaveBeenCalled();
  });

  it("still rejects a bad signature before ever consulting the blocklist", async () => {
    // Signature verification is the security boundary; blocking is a preference
    // layered on top and must not run first.
    verifyIncomingSignature.mockResolvedValue({ valid: false, reason: "bad sig" });
    const res = await POST(req({ type: "Like", actor: BLOCKED, object: "https://demo.example/post/x" }));
    expect(res.status).toBe(401);
    expect(prisma.blockedActor.findUnique).not.toHaveBeenCalled();
  });

  it("fails open if the blocklist lookup errors, rather than dropping everything", async () => {
    vi.mocked(prisma.blockedActor.findUnique).mockRejectedValue(new Error("db down"));
    const res = await POST(req({ type: "Follow", actor: ALLOWED, id: `${ALLOWED}#f1`, object: "https://demo.example/ap/actor" }));
    expect(res.status).toBe(202);
    expect(prisma.fediFollower.upsert).toHaveBeenCalled();
  });
});
