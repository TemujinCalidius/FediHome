import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The server side of "click a person, act on them".
 *
 * Two pieces: a focused relationship lookup so the popup can offer the *right*
 * action rather than Follow and Unfollow side by side, and a follow path that
 * takes an actor URI directly.
 *
 * The by-URI path matters because the only address we reliably hold for a
 * replier is their actor URI. Rebuilding a handle from username+domain and
 * going back through WebFinger is a lossy round-trip — and the guessed
 * `/users/<name>` shape is simply wrong for Lemmy, Akkoma, PeerTube and
 * FediHome itself.
 */

const { authenticateApiRequest, assertPublicHost, isPrivateUrl, deliverActivity } = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  assertPublicHost: vi.fn(),
  isPrivateUrl: vi.fn(),
  deliverActivity: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost, isPrivateUrl }));
vi.mock("@/lib/http-signatures", () => ({ deliverActivity }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediFollowing: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    fediFollower: { findUnique: vi.fn() },
    blockedActor: { findUnique: vi.fn() },
    // follow() now checks the DOMAIN block list before any network call (#379).
    blockedDomain: { findFirst: vi.fn() },
    fediPost: { upsert: vi.fn(), findFirst: vi.fn() },
  },
}));

import { GET } from "@/app/api/graph/status/route";
import { follow } from "@/app/api/admin/_actions/fedi-graph";
import { prisma } from "@/lib/db";

const ACTOR = "https://lemmy.example/u/ada"; // deliberately NOT Mastodon-shaped
const ok = { ok: true };

const statusReq = (uri?: string): NextRequest =>
  new NextRequest(
    `https://demo.example/api/graph/status${uri ? `?actorUri=${encodeURIComponent(uri)}` : ""}`,
  );

beforeEach(() => {
  vi.clearAllMocks();
  authenticateApiRequest.mockResolvedValue(ok);
  assertPublicHost.mockResolvedValue(true);
  isPrivateUrl.mockReturnValue(false);
  deliverActivity.mockResolvedValue({ ok: true, status: 202 });
  vi.mocked(prisma.fediFollowing.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.blockedDomain.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.fediFollowing.upsert).mockResolvedValue({} as never);
});

describe("GET /api/graph/status", () => {
  it("reports both relationships for one actor", async () => {
    vi.mocked(prisma.fediFollowing.findUnique).mockResolvedValue({ id: "f1" } as never);
    vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue({ id: "b1" } as never);

    const res = await GET(statusReq(ACTOR));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ following: true, blocked: true });
  });

  it("reports false/false for a stranger", async () => {
    const res = await GET(statusReq(ACTOR));
    expect(await res.json()).toEqual({ following: false, blocked: false });
  });

  it("looks the actor up by exact URI, not a rebuilt one", async () => {
    await GET(statusReq(ACTOR));
    expect(prisma.fediFollowing.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { actorUri: ACTOR } }),
    );
  });

  it("requires read auth", async () => {
    authenticateApiRequest.mockResolvedValue({ ok: false });
    const req = statusReq(ACTOR);
    expect((await GET(req)).status).toBe(401);
    expect(authenticateApiRequest).toHaveBeenCalledWith(req, "read");
    expect(prisma.fediFollowing.findUnique).not.toHaveBeenCalled();
  });

  it("400s without an actorUri", async () => {
    expect((await GET(statusReq())).status).toBe(400);
  });
});

describe("follow() by actor URI", () => {
  /** The remote actor document a follow-by-URI fetches. */
  const actorDoc = {
    id: ACTOR,
    preferredUsername: "ada",
    name: "Ada",
    inbox: "https://lemmy.example/u/ada/inbox",
  };

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify(actorDoc), {
        status: 200,
        headers: { "content-type": "application/activity+json" },
      }),
    ) as unknown as typeof fetch;
  });

  it("never calls WebFinger — it already has the actor URI", async () => {
    const res = await follow({ actorUri: ACTOR } as never);
    expect(res.status).toBe(200);

    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/.well-known/webfinger"))).toBe(false);
    expect(urls).toContain(ACTOR);
  });

  it("stores the actor URI verbatim, keeping a non-Mastodon path intact", async () => {
    await follow({ actorUri: ACTOR } as never);
    expect(prisma.fediFollowing.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { actorUri: ACTOR },
        create: expect.objectContaining({
          actorUri: ACTOR,
          domain: "lemmy.example",
          username: "ada",
        }),
      }),
    );
  });

  it("sends a Follow activity to the actor's inbox", async () => {
    await follow({ actorUri: ACTOR } as never);
    const sent = deliverActivity.mock.calls.map((c) => c[1] as { type: string; object: string });
    expect(sent.some((a) => a.type === "Follow" && a.object === ACTOR)).toBe(true);
  });

  it("still applies the SSRF guard to a caller-supplied URI", async () => {
    // The by-URI path skips WebFinger, so it must not skip the guard with it.
    assertPublicHost.mockResolvedValue(false);
    const res = await follow({ actorUri: "https://169.254.169.254/u/x" } as never);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-URL actorUri without touching the network", async () => {
    const res = await follow({ actorUri: "not a url" } as never);
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still supports the handle path for the paste-a-handle box", async () => {
    global.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("webfinger")) {
        return new Response(
          JSON.stringify({
            links: [{ rel: "self", type: "application/activity+json", href: ACTOR }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(actorDoc), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await follow({ handle: "@ada@lemmy.example" } as never);
    expect(res.status).toBe(200);
    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/.well-known/webfinger"))).toBe(true);
  });

  it("records the follow as PENDING, not accepted (#348)", async () => {
    // The row is written the instant we send the Follow, which is not the same
    // thing as their server having agreed to it. Anything else means a
    // manually-approved account is indistinguishable from a real follow.
    global.fetch = vi.fn(async () => new Response(JSON.stringify(actorDoc), { status: 200 })) as unknown as typeof fetch;
    await follow({ actorUri: ACTOR } as never);
    const create = vi.mocked(prisma.fediFollowing.upsert).mock.calls[0][0].create;
    expect(create).toMatchObject({ accepted: false });
  });
});
