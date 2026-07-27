import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

/**
 * Outbound block enforcement (#379).
 *
 * `blocks.ts` documents the block as deliberately local — we never federate a
 * `Block`, "precisely so the blocked person can't tell". That guarantee only
 * holds if we also stop *initiating* contact, and we didn't: `isBlockedSender()`
 * was called from exactly two places, both in the inbox. Outbound follows, DMs,
 * likes, replies and queued retries all kept talking to blocked accounts and
 * blocked instances.
 *
 * The pair of tests that matter most are the two shared-inbox ones. A naive
 * "refuse by inbox" gate would black-hole `https://mastodon.social/inbox`, which
 * serves every account on the host — turning a one-account block into an
 * instance-wide outage nobody asked for.
 *
 * This file runs the REAL http-signatures module against a mocked database, so
 * `global.fetch` is the ground truth for "did we contact them".
 */

vi.mock("@/lib/url-guard", () => ({ assertPublicHost: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    actorKeys: { findUnique: vi.fn() },
    fediFollower: { findMany: vi.fn() },
    failedDelivery: { upsert: vi.fn() },
    blockedActor: { findUnique: vi.fn(), findMany: vi.fn() },
    blockedDomain: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

import { deliverActivity, deliverToFollowers } from "@/lib/http-signatures";
import { prisma } from "@/lib/db";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const SHARED_INBOX = "https://mastodon.social/inbox";
const MALLORY = "https://mastodon.social/users/mallory";
const ADA = "https://mastodon.social/users/ada";
const activity = { id: "https://me/ap/create/1", type: "Create", actor: "https://me/ap/actor" };

/** Only `actorUri` is blocked. */
const blockActor = (actorUri: string) =>
  vi
    .mocked(prisma.blockedActor.findUnique)
    .mockImplementation((async (a: { where: { actorUri: string } }) =>
      a.where.actorUri === actorUri ? { id: "b1" } : null) as never);

/** Any of `domains` is blocked. */
const blockDomains = (...domains: string[]) =>
  vi
    .mocked(prisma.blockedDomain.findFirst)
    .mockImplementation((async (a: { where: { domain: { in: string[] } } }) =>
      a.where.domain.in.some((d) => domains.includes(d)) ? { id: "d1" } : null) as never);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://me";
  vi.mocked(prisma.actorKeys.findUnique).mockResolvedValue({ id: "main", publicKey, privateKey } as never);
  vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.blockedDomain.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.failedDelivery.upsert).mockResolvedValue({} as never);
  global.fetch = vi.fn(async () => new Response("", { status: 202 })) as unknown as typeof fetch;
});

describe("the shared-inbox pair — an actor block must not black-hole an instance", () => {
  it("refuses a blocked actor reached through a shared inbox", async () => {
    blockActor(MALLORY);
    const res = await deliverActivity(SHARED_INBOX, activity, { actorUri: MALLORY });
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toBe("actor");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still delivers to an UNBLOCKED actor on that same shared inbox", async () => {
    // If this ever fails, blocking one person has silenced a whole instance.
    blockActor(MALLORY);
    const res = await deliverActivity(SHARED_INBOX, activity, { actorUri: ADA });
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("delivers to a shared inbox when no actor URI is known", async () => {
    // A queued FailedDelivery row has only an inbox. Refusing on that basis
    // would drop mail for every account behind it.
    blockActor(MALLORY);
    const res = await deliverActivity(SHARED_INBOX, activity);
    expect(res.ok).toBe(true);
  });
});

describe("domain blocks are decidable from the inbox alone", () => {
  it("refuses without an actor URI — this is what covers the retry queue", async () => {
    blockDomains("spam.example");
    const res = await deliverActivity("https://spam.example/inbox", activity);
    expect(res.blockedBy).toBe("domain");
    expect(res.permanent).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("covers subdomains", async () => {
    blockDomains("spam.example");
    const res = await deliverActivity("https://a.b.spam.example/inbox", activity);
    expect(res.blockedBy).toBe("domain");
  });

  it("refuses an inbox on a non-default PORT of a blocked domain", async () => {
    // Regression for the bypass found while fixing this: actorHost() used .host,
    // so a host of "spam.example:8443" produced the single domainChain candidate
    // "spam.example:8443", which never matched the port-less stored row.
    blockDomains("spam.example");
    const res = await deliverActivity("https://spam.example:8443/inbox", activity);
    expect(res.blockedBy).toBe("domain");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses when the ACTOR's domain is blocked but the inbox host isn't", async () => {
    blockDomains("spam.example");
    const res = await deliverActivity("https://relay.example/inbox", activity, {
      actorUri: "https://spam.example/users/x",
    });
    expect(res.blockedBy).toBe("domain");
  });

  it("leaves an unrelated host alone", async () => {
    blockDomains("spam.example");
    expect((await deliverActivity("https://good.example/inbox", activity)).ok).toBe(true);
  });
});

describe("failure classification", () => {
  it("fails CLOSED when the block list is unreadable — but stays retryable", async () => {
    // Fail closed because an outbound send can't be unsent. Retryable because
    // dropping every post over a five-second Postgres hiccup is worse than the
    // bug being fixed.
    vi.mocked(prisma.blockedDomain.findFirst).mockRejectedValue(new Error("db down") as never);
    const res = await deliverActivity("https://good.example/inbox", activity);
    expect(res.ok).toBe(false);
    expect(res.permanent).not.toBe(true);
    expect(res.blockedBy).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("marks a definitive remote refusal permanent", async () => {
    global.fetch = vi.fn(async () => new Response("gone", { status: 410 })) as unknown as typeof fetch;
    expect((await deliverActivity("https://good.example/inbox", activity)).permanent).toBe(true);
  });

  it("leaves a 500 transient — the retry queue exists for exactly this", async () => {
    global.fetch = vi.fn(async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    const res = await deliverActivity("https://good.example/inbox", activity);
    expect(res.permanent).toBeFalsy();
  });
});

describe("bypassBlocks", () => {
  it("delivers anyway — block()'s farewell Undo is the one legitimate use", async () => {
    blockActor(MALLORY);
    const res = await deliverActivity(SHARED_INBOX, activity, { actorUri: MALLORY, bypassBlocks: true });
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("follower fan-out", () => {
  const follower = (actorUri: string, inbox: string, sharedInbox: string | null = null) => ({
    actorUri,
    inbox,
    sharedInbox,
  });

  it("drops a follower on a blocked domain before sending", async () => {
    // Their row normally disappears when you block the domain — but not always:
    // the purge matched on the stored `domain` column, which used to keep a port.
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([
      follower("https://spam.example/users/x", "https://spam.example/inbox"),
      follower("https://good.example/users/y", "https://good.example/inbox"),
    ] as never);
    vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([{ domain: "spam.example" }] as never);

    await deliverToFollowers(activity);

    const hit = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(hit).toEqual(["https://good.example/inbox"]);
  });

  it("delivers nothing at all when the block list is unreadable", async () => {
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([
      follower("https://good.example/users/y", "https://good.example/inbox"),
    ] as never);
    vi.mocked(prisma.blockedDomain.findMany).mockRejectedValue(new Error("db down") as never);

    await deliverToFollowers(activity);

    expect(global.fetch).not.toHaveBeenCalled();
    // Nothing queued either — the next post goes out normally once the DB is back.
    expect(prisma.failedDelivery.upsert).not.toHaveBeenCalled();
  });

  it("never enqueues a permanent failure for retry", async () => {
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([
      follower("https://good.example/users/y", "https://good.example/inbox"),
    ] as never);
    global.fetch = vi.fn(async () => new Response("gone", { status: 410 })) as unknown as typeof fetch;

    await deliverToFollowers(activity);

    expect(prisma.failedDelivery.upsert).not.toHaveBeenCalled();
  });

  it("still enqueues a transient failure", async () => {
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([
      follower("https://good.example/users/y", "https://good.example/inbox"),
    ] as never);
    global.fetch = vi.fn(async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;

    await deliverToFollowers(activity);

    expect(prisma.failedDelivery.upsert).toHaveBeenCalledTimes(1);
  });
});
