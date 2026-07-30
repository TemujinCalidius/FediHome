import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

vi.mock("@/lib/url-guard", () => ({ assertPublicHost: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediFollower: { findMany: vi.fn() },
    actorKeys: { findUnique: vi.fn() },
    failedDelivery: { upsert: vi.fn() },
    // deliverToFollowers now consults the block lists before fan-out (#379).
    blockedActor: { findUnique: vi.fn(), findMany: vi.fn() },
    blockedDomain: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

import { deliverToFollowers, enqueueFailedDeliveries } from "@/lib/http-signatures";
import { prisma } from "@/lib/db";

// A real RSA keypair so signedFetch can actually sign (crypto rejects fakes).
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const activity = { id: "https://me/ap/create/1", type: "Create", actor: "https://me/ap/actor" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://me";
  vi.mocked(prisma.actorKeys.findUnique).mockResolvedValue({ id: "main", publicKey, privateKey } as never);
  vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.blockedDomain.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.failedDelivery.upsert).mockResolvedValue({} as never);
});

describe("deliverToFollowers → FailedDelivery enqueue (#207)", () => {
  it("enqueues a retry row for a follower inbox that 500s", async () => {
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([
      { inbox: "https://down.example/inbox", sharedInbox: null },
    ] as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));

    await deliverToFollowers(activity);

    expect(prisma.failedDelivery.upsert).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.failedDelivery.upsert).mock.calls[0][0];
    expect(arg.where).toEqual({ activityId_inbox: { activityId: "https://me/ap/create/1", inbox: "https://down.example/inbox" } });
    expect(arg.create).toMatchObject({ activityId: "https://me/ap/create/1", inbox: "https://down.example/inbox", attempts: 1 });
    // the stored activity is the exact JSON, so a retry re-sends the same id
    expect(JSON.parse((arg.create as { activity: string }).activity)).toEqual(activity);
    vi.unstubAllGlobals();
  });

  it("does NOT enqueue when delivery succeeds (202)", async () => {
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([
      { inbox: "https://ok.example/inbox", sharedInbox: null },
    ] as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));

    await deliverToFollowers(activity);

    expect(prisma.failedDelivery.upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("enqueues nothing when the activity has no id (can't dedupe a retry)", async () => {
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([
      { inbox: "https://down.example/inbox", sharedInbox: null },
    ] as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await deliverToFollowers({ type: "Create" }); // no id

    expect(prisma.failedDelivery.upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("enqueueFailedDeliveries", () => {
  it("upserts one idempotent row per failed inbox and truncates the error", async () => {
    await enqueueFailedDeliveries("act1", "{}", [
      { inbox: "https://a/inbox", error: "x".repeat(500) },
      { inbox: "https://b/inbox", error: "timeout" },
    ]);
    expect(prisma.failedDelivery.upsert).toHaveBeenCalledTimes(2);
    const first = vi.mocked(prisma.failedDelivery.upsert).mock.calls[0][0];
    expect((first.create as { lastError: string }).lastError.length).toBe(300);
    expect(first.update).toMatchObject({ attempts: { increment: 1 } });
  });

  it("never throws even if the upsert rejects (delivery must not break)", async () => {
    vi.mocked(prisma.failedDelivery.upsert).mockRejectedValue(new Error("db down"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(enqueueFailedDeliveries("act1", "{}", [{ inbox: "https://a/inbox", error: "e" }])).resolves.toBeUndefined();
    consoleErr.mockRestore();
  });
});

describe("the queued row remembers who it was for (#397)", () => {
  it("carries the actor URI for a private inbox", async () => {
    // It was dropped twice before: once by the shared-inbox collapsing, and
    // again because the failure record had no field for it. So FailedDelivery
    // rows never knew their recipient and the retry sweep could only ever ask
    // "is this HOST blocked?".
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([
      { actorUri: "https://m.example/users/ada", inbox: "https://m.example/users/ada/inbox", sharedInbox: null },
    ] as never);
    global.fetch = vi.fn(async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;

    await deliverToFollowers(activity);

    const create = vi.mocked(prisma.failedDelivery.upsert).mock.calls[0][0].create as { actorUri: string | null };
    expect(create.actorUri).toBe("https://m.example/users/ada");
  });

  it("stores null for a shared inbox", async () => {
    // A shared inbox serves many accounts and identifies none of them.
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([
      { actorUri: "https://m.example/users/ada", inbox: "https://m.example/users/ada/inbox", sharedInbox: "https://m.example/inbox" },
    ] as never);
    global.fetch = vi.fn(async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;

    await deliverToFollowers(activity);

    const create = vi.mocked(prisma.failedDelivery.upsert).mock.calls[0][0].create as { actorUri: string | null };
    expect(create.actorUri).toBeNull();
  });
});

