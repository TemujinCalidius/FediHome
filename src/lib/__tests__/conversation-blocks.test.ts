import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Block enforcement when opening a thread (#396).
 *
 * Blocking works by purging at block time and gating at ingest — `block()`
 * deletes the actor's cached posts and the inbox refuses anything further from
 * them. `/api/conversation` was a third ingest path with **no block check
 * anywhere in the file**, so opening any thread a blocked actor had replied in
 * fetched their post and wrote it straight back.
 *
 * Two consequences, and the second is the worse one:
 *
 *  - it reverses the purge, and nothing removes those rows again;
 *  - a re-imported thread *ancestor* is a top-level row, so it lands back in
 *    `/timeline` permanently — not just in the thread view.
 *
 * It also made signed outbound requests to blocked hosts, which is the exact
 * behaviour #379 was opened to end. Hence the gates sit before the network call,
 * not merely before the write.
 *
 * This route had no test coverage of any kind before this file.
 */

const { signedGet } = vi.hoisted(() => ({ signedGet: vi.fn() }));
vi.mock("@/lib/http-signatures", () => ({ signedGet }));
vi.mock("@/lib/fedi-media", () => ({
  processAttachments: vi.fn().mockResolvedValue({ urls: [], types: [] }),
  fetchLinkEmbed: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/sanitize", () => ({ sanitizeHtml: (s: string) => s }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost: vi.fn().mockResolvedValue(true) }));
const { authenticateApiRequest } = vi.hoisted(() => ({ authenticateApiRequest: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediPost: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    blockedActor: { findMany: vi.fn(), findUnique: vi.fn() },
    blockedDomain: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

import { GET } from "@/app/api/conversation/route";
import { prisma } from "@/lib/db";

const OURS = "https://demo.example/ap/reply/1";
const MALLORY = "https://spam.example/users/mallory";
const ADA = "https://mastodon.example/users/ada";

// The route reads `req.nextUrl.searchParams`, which a plain Request doesn't have.
const req = (postId: string): NextRequest => {
  const url = new URL(`https://demo.example/api/conversation?postId=${postId}`);
  return { nextUrl: url, url: url.toString(), headers: new Headers() } as unknown as NextRequest;
};

/** A Mastodon `/context` status, as the route expects it. */
const status = (uri: string, actorUri: string, id: string) => ({
  id,
  uri,
  content: "<p>hello</p>",
  created_at: "2026-07-01T00:00:00.000Z",
  account: { uri: actorUri, acct: "someone", username: "someone", display_name: "Someone", avatar: null },
});

const contextResponse = (ancestors: unknown[], descendants: unknown[] = []) =>
  new Response(JSON.stringify({ ancestors, descendants }), { status: 200 });

beforeEach(() => {
  vi.clearAllMocks();
  authenticateApiRequest.mockResolvedValue({ ok: true });
  vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({
    id: "p1",
    apId: OURS,
    actorUri: "https://demo.example/ap/actor",
    inReplyTo: null,
    publishedAt: new Date(),
    createdAt: new Date(),
  } as never);
  vi.mocked(prisma.fediPost.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.fediPost.upsert).mockImplementation((async (a: { create: unknown }) => ({
    ...(a.create as object),
    publishedAt: new Date(),
    createdAt: new Date(),
  })) as never);
  vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.blockedDomain.findFirst).mockResolvedValue(null as never);
  global.fetch = vi.fn(async () => contextResponse([])) as unknown as typeof fetch;
});

describe("the Mastodon context ingest", () => {
  it("does not re-import a blocked actor's post — the regression test", async () => {
    // On the pre-fix route this upserts, undoing the purge.
    vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([{ actorUri: MALLORY }] as never);
    global.fetch = vi.fn(async () =>
      contextResponse([status("https://spam.example/statuses/9", MALLORY, "9")]),
    ) as unknown as typeof fetch;

    const res = await GET(req("p1"));
    expect(res.status).toBe(200);
    expect(prisma.fediPost.upsert).not.toHaveBeenCalled();
  });

  it("still imports everyone else in the same thread", async () => {
    // The gate must be per-status, not "drop the whole thread".
    vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([{ actorUri: MALLORY }] as never);
    global.fetch = vi.fn(async () =>
      contextResponse([
        status("https://spam.example/statuses/9", MALLORY, "9"),
        status("https://mastodon.example/statuses/7", ADA, "7"),
      ]),
    ) as unknown as typeof fetch;

    await GET(req("p1"));

    const written = vi.mocked(prisma.fediPost.upsert).mock.calls.map(
      (c) => (c[0].create as { actorUri: string }).actorUri,
    );
    expect(written).toEqual([ADA]);
  });

  it("excludes an actor on a blocked domain, and its subdomains", async () => {
    vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([{ domain: "spam.example" }] as never);
    global.fetch = vi.fn(async () =>
      contextResponse([status("https://a.b.spam.example/statuses/9", "https://a.b.spam.example/users/x", "9")]),
    ) as unknown as typeof fetch;

    await GET(req("p1"));
    expect(prisma.fediPost.upsert).not.toHaveBeenCalled();
  });

  it("checks the whole context in a bounded number of queries", async () => {
    // A per-status check would be two queries each; a thread can carry 400.
    global.fetch = vi.fn(async () =>
      contextResponse(
        Array.from({ length: 50 }, (_, i) =>
          status(`https://mastodon.example/statuses/${i}`, `https://mastodon.example/users/u${i}`, String(i)),
        ),
      ),
    ) as unknown as typeof fetch;

    await GET(req("p1"));

    expect(vi.mocked(prisma.blockedActor.findMany).mock.calls.length).toBeLessThanOrEqual(2);
    expect(vi.mocked(prisma.blockedDomain.findMany).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("fails CLOSED — an unreadable block list imports nothing", async () => {
    // Refusing to ingest costs a thread view the owner can retry. Ingesting
    // wrongly writes rows only another explicit block will ever clear.
    vi.mocked(prisma.blockedActor.findMany).mockRejectedValue(new Error("db down") as never);
    global.fetch = vi.fn(async () =>
      contextResponse([status("https://mastodon.example/statuses/7", ADA, "7")]),
    ) as unknown as typeof fetch;

    await GET(req("p1"));
    expect(prisma.fediPost.upsert).not.toHaveBeenCalled();
  });
});

describe("outbound contact", () => {
  it("never asks a blocked instance for a thread", async () => {
    // Not just "don't store it" — don't ask. Same reasoning as follow()'s
    // pre-WebFinger domain check (#379).
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({
      id: "p1",
      apId: "https://spam.example/statuses/1",
      actorUri: MALLORY,
      inReplyTo: null,
      publishedAt: new Date(),
      createdAt: new Date(),
    } as never);
    vi.mocked(prisma.blockedDomain.findFirst).mockResolvedValue({ id: "d1" } as never);

    await GET(req("p1"));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("never signs a GET to a blocked host while walking ancestors", async () => {
    // The fallback path did a signedGet on each ancestor AND on its actor.
    vi.mocked(prisma.fediPost.findUnique).mockImplementation((async (a: { where: { id?: string } }) =>
      a.where.id
        ? {
            id: "p1",
            apId: OURS,
            actorUri: "https://demo.example/ap/actor",
            inReplyTo: "https://spam.example/statuses/parent",
            publishedAt: new Date(),
            createdAt: new Date(),
          }
        : null) as never);
    // No Mastodon context → the fallback ancestor walk runs.
    global.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    vi.mocked(prisma.blockedDomain.findFirst).mockResolvedValue({ id: "d1" } as never);

    await GET(req("p1"));

    expect(signedGet).not.toHaveBeenCalled();
    expect(prisma.fediPost.upsert).not.toHaveBeenCalled();
  });
});

/**
 * #559. Blocking was enforced at ingest and on the feed, but two reads in this
 * route returned a blocked author's post to the owner anyway: the start post
 * (a bare findUnique reaching every response branch) and the cached half of the
 * ancestor walk.
 */
describe("#559 — reads, not just ingest", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "x",
    apId: null,
    actorUri: "https://demo.example/ap/actor",
    inReplyTo: null,
    publishedAt: new Date(),
    createdAt: new Date(),
    ...over,
  });

  it("404s a blocked author's post opened by id — same as one that isn't there", async () => {
    // Deliberately the SAME status as absent: a different one would turn this
    // into an oracle for whether a given id exists.
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(
      row({ id: "p1", apId: "https://spam.example/notes/1", actorUri: MALLORY }) as never,
    );
    vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([{ actorUri: MALLORY }] as never);
    const res = await GET(req("p1"));
    expect(res.status).toBe(404);
  });

  it("404s a blocked BLUESKY post, whose actorUri is a DID", async () => {
    // The reason this uses blockedActorUris rather than isBlockedSender:
    // uriHostname("did:plc:…") is null, so isBlockedSender's domain half would
    // silently no-op on exactly these rows.
    const did = "did:plc:mallory";
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(
      row({ id: "b1", apId: null, actorUri: did, conversationId: null }) as never,
    );
    vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([{ actorUri: did }] as never);
    expect((await GET(req("b1"))).status).toBe(404);
  });

  it("hides a blocked ancestor but keeps the grandparent above it", async () => {
    // The semantics chosen for this: hide THEIR post and nothing else. Walking
    // must continue past a blocked ancestor, or blocking one person silently
    // truncates the thread above them.
    const GRAN = "https://mastodon.example/notes/gran";
    const BAD = "https://spam.example/notes/bad";
    global.fetch = vi.fn(async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    vi.mocked(prisma.fediPost.findUnique).mockImplementation((async (a: {
      where: { id?: string; apId?: string };
    }) => {
      if (a.where.id) return row({ id: "p1", apId: OURS, actorUri: ADA, inReplyTo: BAD });
      if (a.where.apId === BAD) return row({ id: "bad", apId: BAD, actorUri: MALLORY, inReplyTo: GRAN });
      if (a.where.apId === GRAN) return row({ id: "gran", apId: GRAN, actorUri: ADA, inReplyTo: null });
      return null;
    }) as never);
    vi.mocked(prisma.blockedActor.findMany).mockImplementation((async (a: {
      where?: { actorUri?: { in?: string[] } };
    }) => {
      const asked = a?.where?.actorUri?.in ?? [];
      return asked.includes(MALLORY) ? [{ actorUri: MALLORY }] : [];
    }) as never);

    const body = await (await GET(req("p1"))).json();
    const ids = (body.thread as { id: string }[]).map((p) => p.id);
    expect(ids).toContain("gran");
    expect(ids).not.toContain("bad");
  });

  it("keeps other people's replies to the hidden post visible", async () => {
    // The assertion that separates this from the simpler wrong fix. threadApIds
    // is derived from the ancestors we KEPT, so dropping the blocked row from
    // that list would delete replies by people the owner never blocked.
    const BAD = "https://spam.example/notes/bad";
    global.fetch = vi.fn(async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    vi.mocked(prisma.fediPost.findUnique).mockImplementation((async (a: {
      where: { id?: string; apId?: string };
    }) => {
      if (a.where.id) return row({ id: "p1", apId: OURS, actorUri: ADA, inReplyTo: BAD });
      if (a.where.apId === BAD) return row({ id: "bad", apId: BAD, actorUri: MALLORY, inReplyTo: null });
      return null;
    }) as never);
    vi.mocked(prisma.blockedActor.findMany).mockImplementation((async (a: {
      where?: { actorUri?: { in?: string[] } };
    }) => {
      const asked = a?.where?.actorUri?.in ?? [];
      return asked.includes(MALLORY) ? [{ actorUri: MALLORY }] : [];
    }) as never);

    await GET(req("p1"));
    // The reply query must still be told about the hidden ancestor's apId.
    const where = vi.mocked(prisma.fediPost.findMany).mock.calls[0][0]?.where as {
      inReplyTo?: { in?: string[] };
    };
    expect(where?.inReplyTo?.in).toContain(BAD);
  });
});
