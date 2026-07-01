import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { authenticateApiRequest } = vi.hoisted(() => ({ authenticateApiRequest: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediFollower: { findMany: vi.fn(), count: vi.fn() },
    fediFollowing: { findMany: vi.fn(), count: vi.fn() },
    blueskyFollower: { findMany: vi.fn(), count: vi.fn() },
    blueskyFollowing: { findMany: vi.fn(), count: vi.fn() },
    directMessage: { findMany: vi.fn() },
    dmConversationRead: { findMany: vi.fn() },
    post: { count: vi.fn() },
  },
}));

import { GET as graphGET } from "@/app/api/graph/route";
import { GET as dmsGET } from "@/app/api/dms/route";
import { GET as accountGET } from "@/app/api/account/route";
import { prisma } from "@/lib/db";

const req = {} as unknown as NextRequest;
const ok = { ok: true, via: "bearer", scope: "read dm" };
const no = { ok: false, via: null, scope: "" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/graph (read)", () => {
  it("401 with no auth", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await graphGET(req)).status).toBe(401);
    expect(authenticateApiRequest).toHaveBeenCalledWith(req, "read");
  });

  it("merges fedi + bsky followers/following with counts", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    vi.mocked(prisma.fediFollowing.findMany).mockResolvedValue([
      { id: "f1", actorUri: "u", username: "a", domain: "d", displayName: null, avatarUrl: null, createdAt: new Date("2026-01-02") },
    ] as never);
    vi.mocked(prisma.fediFollower.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.blueskyFollower.findMany).mockResolvedValue([
      { id: "b1", did: "did:x", handle: "h", displayName: null, avatarUrl: null, createdAt: new Date("2026-01-01") },
    ] as never);
    vi.mocked(prisma.blueskyFollowing.findMany).mockResolvedValue([] as never);
    const body = await (await graphGET(req)).json();
    expect(body.counts).toEqual({ followers: 1, following: 1 });
    expect(body.following[0].source).toBe("fedi");
    expect(body.followers[0].source).toBe("bsky");
  });
});

describe("GET /api/dms (dm scope)", () => {
  it("requires the `dm` scope and 401s without it", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await dmsGET(req)).status).toBe(401);
    expect(authenticateApiRequest).toHaveBeenCalledWith(req, "dm");
  });

  it("returns messages + read state", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    vi.mocked(prisma.directMessage.findMany).mockResolvedValue([
      { id: "m1", contentHtml: "<p>hey</p>", createdAt: new Date() },
    ] as never);
    vi.mocked(prisma.dmConversationRead.findMany).mockResolvedValue([
      { conversationKey: "k", lastReadAt: new Date("2026-01-01T00:00:00Z") },
    ] as never);
    const body = await (await dmsGET(req)).json();
    expect(body.messages).toHaveLength(1);
    expect(body.readState.k).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("GET /api/account (read)", () => {
  it("401 with no auth", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await accountGET(req)).status).toBe(401);
  });

  it("returns identity + counts", async () => {
    authenticateApiRequest.mockResolvedValue(ok);
    vi.mocked(prisma.fediFollower.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.blueskyFollower.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.fediFollowing.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.blueskyFollowing.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.post.count).mockResolvedValue(7 as never);
    const body = await (await accountGET(req)).json();
    expect(body.counts).toEqual({ followers: 5, following: 1, posts: 7 });
    expect(typeof body.fediAddress).toBe("string");
    expect(body.actor).toContain("/ap/actor");
  });
});
