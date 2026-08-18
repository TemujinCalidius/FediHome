import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * #559. `/api/replies` lists the owner's own replies — `isOutgoing: true`, so
 * blocks genuinely don't apply — and then attaches a summary of each reply's
 * PARENT, which is somebody else's post. That second query had no filter, so a
 * blocked account's name, avatar and a snippet of their post were rendered in
 * the owner's own reply list.
 *
 * It had been marked exempt from the read-path guard on the strength of the
 * FIRST query's `isOutgoing`. That is the whole shape of the bug: a true reason,
 * recorded against a file rather than a query.
 *
 * This route had no test of any kind before now.
 */

const { verifyAdmin } = vi.hoisted(() => ({ verifyAdmin: vi.fn() }));
vi.mock("@/lib/auth", () => ({ verifyAdmin }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediPost: { findMany: vi.fn() },
    blockedActor: { findMany: vi.fn() },
    blockedDomain: { findMany: vi.fn() },
  },
}));

import { GET } from "@/app/api/replies/route";
import { prisma } from "@/lib/db";

const MALLORY = "https://spam.example/users/mallory";
const PARENT = "https://spam.example/notes/1";

const req = (): NextRequest => {
  const url = new URL("https://demo.example/api/replies");
  return { nextUrl: url, url: url.toString(), headers: new Headers() } as unknown as NextRequest;
};

/** The `where` of the Nth fediPost.findMany — 0 is our replies, 1 is the parents. */
const whereOf = (n: number) =>
  (vi.mocked(prisma.fediPost.findMany).mock.calls[n]?.[0]?.where ?? {}) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  verifyAdmin.mockResolvedValue(true);
  vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([{ actorUri: MALLORY }] as never);
  vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.fediPost.findMany)
    .mockResolvedValueOnce([
      {
        id: "r1",
        inReplyTo: PARENT,
        publishedAt: new Date(),
        createdAt: new Date(),
        content: "<p>mine</p>",
      },
    ] as never)
    .mockResolvedValueOnce([] as never);
});

describe("#559 — the parent summary is somebody else's post", () => {
  it("filters the parent query on the block list", async () => {
    await GET(req());
    // The real helper runs against the mocked tables, so this is the actual
    // NOT/OR shape rather than a stubbed sentinel.
    expect(whereOf(1)).toHaveProperty("NOT");
  });

  it("leaves our own replies unfiltered — blocks don't apply to us", async () => {
    await GET(req());
    expect(whereOf(0)).toMatchObject({ isOutgoing: true });
    expect(whereOf(0)).not.toHaveProperty("NOT");
  });

  it("renders parent: null for a blocked parent, which the UI already handles", async () => {
    // Absence rather than a distinct marker, deliberately: TimelineClient has
    // rendered a fallback line for an uncached parent since this route existed,
    // and a different message for a blocked one would tell the owner a row is
    // being withheld.
    //
    // The parent row is returned by the MOCK on purpose. The default fixture
    // returns none, which would make this pass whether the route filtered or
    // not — a test that cannot fail. Here the database hands the row over and
    // the route's filter is the only thing that can drop it.
    vi.mocked(prisma.fediPost.findMany).mockReset();
    vi.mocked(prisma.fediPost.findMany)
      .mockResolvedValueOnce([
        { id: "r1", inReplyTo: PARENT, publishedAt: new Date(), createdAt: new Date(), content: "<p>mine</p>" },
      ] as never)
      .mockImplementationOnce((async (a: { where?: Record<string, unknown> }) =>
        // Stand in for the database applying the NOT/OR the route passes it.
        a.where && "NOT" in a.where
          ? []
          : [
              {
                apId: PARENT,
                username: "mallory",
                domain: "spam.example",
                displayName: "Mallory",
                avatarUrl: "https://spam.example/av.png",
                content: "<p>theirs</p>",
                publishedAt: new Date(),
              },
            ]) as never);

    const body = await (await GET(req())).json();
    expect(body.replies).toHaveLength(1);
    expect(body.replies[0].parent).toBeNull();
  });

  it("still attaches a parent that isn't blocked", async () => {
    vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.fediPost.findMany).mockReset();
    vi.mocked(prisma.fediPost.findMany)
      .mockResolvedValueOnce([
        { id: "r1", inReplyTo: PARENT, publishedAt: new Date(), createdAt: new Date(), content: "<p>mine</p>" },
      ] as never)
      .mockResolvedValueOnce([
        {
          apId: PARENT,
          username: "ada",
          domain: "mastodon.example",
          displayName: "Ada",
          avatarUrl: null,
          content: "<p>theirs</p>",
          publishedAt: new Date(),
        },
      ] as never);
    const body = await (await GET(req())).json();
    expect(body.replies[0].parent?.username).toBe("ada");
  });
});
