import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { authenticateApiRequest, resolveByHandle, assertPublicHost } = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  resolveByHandle: vi.fn(),
  assertPublicHost: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest }));
vi.mock("@/lib/fedi-resolve", () => ({ resolveFediActorByHandle: resolveByHandle }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost }));
vi.mock("@/lib/sanitize", () => ({ sanitizeHtml: (s: string) => s }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediFollower: { findUnique: vi.fn(), findFirst: vi.fn() },
    fediFollowing: { findUnique: vi.fn(), findFirst: vi.fn() },
    fediPost: { findFirst: vi.fn() },
  },
}));

import { GET } from "@/app/api/profile/route";
import { prisma } from "@/lib/db";

const ok = { ok: true, via: "bearer", scope: "read" };
const no = { ok: false, via: null, scope: "" };
const ACTOR = "https://mastodon.social/users/bob";
const ACTOR_JSON = {
  preferredUsername: "bob", name: "Bob", icon: { url: "https://cdn/av.png" },
  image: { url: "https://cdn/hdr.png" }, summary: "<p>hi there</p>", url: "https://mastodon.social/@bob",
  followers: { totalItems: 10 }, following: { totalItems: 5 }, outbox: { totalItems: 42 },
};

let fetchMock: ReturnType<typeof vi.fn>;
function req(params: Record<string, string>): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  assertPublicHost.mockResolvedValue(true);
  // All "known-actor" lookups default to not-found.
  vi.mocked(prisma.fediFollower.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.fediFollower.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.fediFollowing.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.fediFollowing.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.fediPost.findFirst).mockResolvedValue(null as never);
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ACTOR_JSON });
  vi.stubGlobal("fetch", fetchMock);
});

describe("GET /api/profile", () => {
  it("401 without a read scope", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await GET(req({ actor: ACTOR }))).status).toBe(401);
  });

  it("400 without actor or handle", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    expect((await GET(req({}))).status).toBe(400);
  });

  it("rich profile for a KNOWN actor URI, fetching the DB-sourced URI (#176)", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    vi.mocked(prisma.fediFollower.findUnique).mockResolvedValue({ actorUri: ACTOR } as never);
    const body = await (await GET(req({ actor: ACTOR }))).json();
    expect(fetchMock).toHaveBeenCalled();
    expect(body).toMatchObject({
      handle: "@bob@mastodon.social", displayName: "Bob",
      avatarUrl: "https://cdn/av.png", headerUrl: "https://cdn/hdr.png", summary: "<p>hi there</p>",
      counts: { followers: 10, following: 5, posts: 42 }, partial: false,
    });
  });

  it("404 for an UNKNOWN actor URI (never fetches a raw request URL)", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    const res = await GET(req({ actor: "https://evil.example/users/x" }));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rich profile for a KNOWN handle", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    vi.mocked(prisma.fediFollower.findFirst).mockResolvedValue({ actorUri: ACTOR } as never);
    const body = await (await GET(req({ handle: "@bob@mastodon.social" }))).json();
    expect(fetchMock).toHaveBeenCalled();
    expect(body.partial).toBe(false);
    expect(body.counts.posts).toBe(42);
  });

  it("light discovery card for a STRANGER handle via WebFinger (#177), no arbitrary fetch", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    resolveByHandle.mockResolvedValue({ actorUri: ACTOR, username: "bob", domain: "mastodon.social", displayName: "Bob", avatarUrl: "https://cdn/av.png" });
    const body = await (await GET(req({ handle: "@bob@mastodon.social" }))).json();
    expect(resolveByHandle).toHaveBeenCalledWith("@bob@mastodon.social");
    expect(fetchMock).not.toHaveBeenCalled(); // no rich fetch of a request-derived URL
    expect(body).toMatchObject({ handle: "@bob@mastodon.social", displayName: "Bob", partial: true, summary: null });
    expect(body.counts).toEqual({ followers: null, following: null, posts: null });
  });

  it("404 when a stranger handle can't be resolved", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    resolveByHandle.mockResolvedValue(null);
    expect((await GET(req({ handle: "@nope@x.social" }))).status).toBe(404);
  });
});
