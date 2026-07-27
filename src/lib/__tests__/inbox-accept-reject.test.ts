import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Outbound follow state — `Accept` and `Reject` (#348).
 *
 * `case "Accept"` used to be a comment and a bare `break`, and there was no
 * `Reject` case at all, so an inbound rejection fell through to `default` and
 * was logged only under FEDIHOME_DEBUG. Meanwhile `follow()` writes the
 * `FediFollowing` row the moment the button is pressed. The result: a
 * manually-approved account you were never granted, and an account that
 * explicitly refused you, looked exactly like a real follow — forever.
 *
 * The Follow id can't be used to match. `follow()` mints
 * `${siteUrl}/ap/follow/${Date.now()}` and never persists it. So matching is on
 * the actor pair, and most of the tests below exist to prove that the resulting
 * looser match can't be abused.
 */

const { verifyIncomingSignature, actorMatchesSigner, deliverActivity } = vi.hoisted(() => ({
  verifyIncomingSignature: vi.fn(),
  actorMatchesSigner: vi.fn(),
  deliverActivity: vi.fn(),
}));
vi.mock("@/lib/http-signatures", () => ({
  verifyIncomingSignature,
  actorMatchesSigner,
  deliverActivity,
  signedGet: vi.fn(),
}));
vi.mock("@/lib/fedi-media", () => ({ processAttachments: vi.fn(), fetchLinkEmbed: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushToOwner: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ resolveOwnedTarget: vi.fn() }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost: vi.fn() }));
const { isBlockedSender } = vi.hoisted(() => ({ isBlockedSender: vi.fn() }));
vi.mock("@/lib/blocks", () => ({ isBlockedSender }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediFollowing: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
    },
    maintenanceItem: { upsert: vi.fn() },
  },
}));

import { POST } from "@/app/ap/inbox/route";
import { prisma } from "@/lib/db";

const THEM = "https://mastodon.example/users/ada";
const US = "https://demo.example/ap/actor";

const req = (activity: Record<string, unknown>): NextRequest =>
  new Request("https://demo.example/ap/inbox", {
    method: "POST",
    headers: { "content-type": "application/activity+json" },
    body: JSON.stringify(activity),
  }) as unknown as NextRequest;

/** An Accept/Reject carrying the full Follow object, as Mastodon sends it. */
const wrapped = (type: "Accept" | "Reject", over: Record<string, unknown> = {}) => ({
  type,
  actor: THEM,
  object: { type: "Follow", id: "https://demo.example/ap/follow/1700000000000", actor: US, object: THEM, ...over },
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  verifyIncomingSignature.mockResolvedValue({ valid: true, actorUri: THEM });
  actorMatchesSigner.mockReturnValue(true);
  isBlockedSender.mockResolvedValue(false);
  vi.mocked(prisma.fediFollowing.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.fediFollowing.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.maintenanceItem.upsert).mockResolvedValue({} as never);
});

describe("Accept", () => {
  it("marks the follow accepted — the regression test for the empty case", async () => {
    // On main this fails: `case "Accept"` was a bare `break`, so dispatching an
    // Accept produced no database write of any kind.
    const res = await POST(req(wrapped("Accept")));
    expect(res.status).toBe(202);
    expect(prisma.fediFollowing.updateMany).toHaveBeenCalledWith({
      where: { actorUri: THEM, accepted: false },
      data: { accepted: true },
    });
  });

  it("accepts a bare-string object carrying our follow id", async () => {
    // Not every server echoes the whole Follow back.
    await POST(req({ type: "Accept", actor: THEM, object: "https://demo.example/ap/follow/1700000000000" }));
    expect(prisma.fediFollowing.updateMany).toHaveBeenCalled();
  });

  it("never conjures a following row", async () => {
    // The single most important guard: matching on the actor pair means an
    // Accept from a stranger reaches the handler. It must not create anything.
    vi.mocked(prisma.fediFollowing.updateMany).mockResolvedValue({ count: 0 } as never);
    await POST(req(wrapped("Accept")));
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
    expect(prisma.fediFollowing.create).not.toHaveBeenCalled();
  });

  it("is idempotent — a redelivered Accept updates nothing the second time", async () => {
    await POST(req(wrapped("Accept")));
    // `accepted: false` in the where clause is what makes the repeat a no-op.
    const call = vi.mocked(prisma.fediFollowing.updateMany).mock.calls[0][0];
    expect(call.where).toMatchObject({ accepted: false });
  });

  it("refuses an Accept wrapping someone else's Follow", async () => {
    await POST(req(wrapped("Accept", { actor: "https://elsewhere.example/ap/actor" })));
    expect(prisma.fediFollowing.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an Accept for a Follow addressed to a different actor", async () => {
    await POST(req(wrapped("Accept", { object: "https://other.example/users/bob" })));
    expect(prisma.fediFollowing.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an Accept of something that isn't a Follow", async () => {
    await POST(req(wrapped("Accept", { type: "Like" })));
    expect(prisma.fediFollowing.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a bare-string id pointing somewhere else", async () => {
    await POST(req({ type: "Accept", actor: THEM, object: "https://evil.example/ap/follow/1" }));
    expect(prisma.fediFollowing.updateMany).not.toHaveBeenCalled();
  });

  it("tolerates a Follow object with no explicit type", async () => {
    const a = wrapped("Accept") as { object: Record<string, unknown> };
    delete a.object.type;
    await POST(req(a as unknown as Record<string, unknown>));
    expect(prisma.fediFollowing.updateMany).toHaveBeenCalled();
  });
});

describe("Reject", () => {
  it("drops the follow and raises exactly one alert", async () => {
    const res = await POST(req(wrapped("Reject")));
    expect(res.status).toBe(202);
    expect(prisma.fediFollowing.deleteMany).toHaveBeenCalledWith({ where: { actorUri: THEM } });
    expect(prisma.maintenanceItem.upsert).toHaveBeenCalledTimes(1);
  });

  it("keys the alert per actor, and never resurrects a dismissed one", async () => {
    await POST(req(wrapped("Reject")));
    const arg = vi.mocked(prisma.maintenanceItem.upsert).mock.calls[0][0];
    // Actor in packageName: distinct rejections stay distinct rows, repeats collapse.
    expect(arg.where).toEqual({
      kind_packageName_latest: { kind: "federation", packageName: THEM, latest: "follow-rejected" },
    });
    expect(arg.update).toEqual({});
  });

  it("deletes an ACCEPTED follow too — Reject also revokes", async () => {
    // Mastodon sends Reject when someone removes an existing follower.
    await POST(req(wrapped("Reject")));
    const arg = vi.mocked(prisma.fediFollowing.deleteMany).mock.calls[0][0];
    expect(arg?.where).not.toHaveProperty("accepted");
  });

  it("stays silent when we never followed them", async () => {
    // The anti-spam guard: only a follow the owner initiated can raise an alert,
    // so a hostile instance can't manufacture notification rows.
    vi.mocked(prisma.fediFollowing.deleteMany).mockResolvedValue({ count: 0 } as never);
    await POST(req(wrapped("Reject")));
    expect(prisma.maintenanceItem.upsert).not.toHaveBeenCalled();
  });

  it("refuses a Reject wrapping someone else's Follow", async () => {
    await POST(req(wrapped("Reject", { actor: "https://elsewhere.example/ap/actor" })));
    expect(prisma.fediFollowing.deleteMany).not.toHaveBeenCalled();
  });
});

describe("the existing gates still cover the new cases", () => {
  it("drops Accept and Reject from a blocked actor", async () => {
    isBlockedSender.mockResolvedValue(true);
    for (const type of ["Accept", "Reject"] as const) {
      await POST(req(wrapped(type)));
    }
    expect(prisma.fediFollowing.updateMany).not.toHaveBeenCalled();
    expect(prisma.fediFollowing.deleteMany).not.toHaveBeenCalled();
  });

  it("drops both when the signature doesn't bind the actor", async () => {
    actorMatchesSigner.mockReturnValue(false);
    expect((await POST(req(wrapped("Accept")))).status).toBe(401);
    expect(prisma.fediFollowing.updateMany).not.toHaveBeenCalled();
  });
});
