import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #386 — the Explore feed.
 *
 * Two halves, and both are asserted here because either alone is useless:
 *
 *  1. the resolver only stores what it is allowed to store — public posts, by
 *     people who aren't blocked, that we don't already have;
 *  2. every timeline-shaped read keeps the result OFF the feeds. A reply-parent
 *     is a thread root, so it has no `inReplyTo` and no `boostedBy` — which is
 *     exactly the shape that reached the public page in #460. The same trap,
 *     one ingestion path later.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const FOLLOWED = "https://friend.example/users/ada";
const STRANGER = "https://elsewhere.example/users/mallory";
const PARENT = "https://elsewhere.example/notes/1";

function note(over: Record<string, unknown> = {}) {
  return {
    type: "Note",
    id: PARENT,
    attributedTo: STRANGER,
    content: "<p>a stranger's post</p>",
    to: [PUBLIC],
    published: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

interface Harness {
  settings: Record<string, unknown>;
  following: string[];
  replies: { inReplyTo: string | null }[];
  have: string[];
  blocked: string[];
  json: Record<string, unknown> | null;
  ok: boolean;
  actor: Record<string, unknown> | null;
}

async function load(over: Partial<Harness> = {}) {
  const h: Harness = {
    settings: { enabled: true, replyParents: true, lookbackDays: 7, maxStored: 500 },
    following: [FOLLOWED],
    replies: [{ inReplyTo: PARENT }],
    have: [],
    blocked: [],
    json: note(),
    ok: true,
    actor: { username: "mallory", domain: "elsewhere.example", displayName: "Mal", avatarUrl: null },
    ...over,
  };

  const upsert = vi.fn().mockResolvedValue({});
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const count = vi.fn().mockResolvedValue(0);
  // Three distinct fediPost.findMany calls, told apart by their `select`:
  // the overflow probe takes mediaUrls, the "do we already have it?" probe takes
  // apId, and the candidate scan takes inReplyTo.
  const fediPostFindMany = vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
    const select = (args.select ?? {}) as Record<string, boolean>;
    if (select.mediaUrls) return [];
    if (select.apId) return h.have.map((apId) => ({ apId }));
    return h.replies;
  });

  const guardedFetch = vi.fn().mockResolvedValue({
    ok: h.ok,
    json: async () => h.json,
  });
  const resolveFediActorByUri = vi.fn().mockResolvedValue(h.actor);
  const isBlockedSender = vi.fn(async (uri: string) => h.blocked.includes(uri));
  const removeFediMediaFiles = vi.fn().mockResolvedValue(0);

  vi.doMock("@/lib/db", () => ({
    prisma: {
      fediFollowing: {
        findMany: vi.fn().mockResolvedValue(h.following.map((actorUri) => ({ actorUri }))),
      },
      fediPost: { findMany: fediPostFindMany, upsert, count, deleteMany },
      post: { findMany: vi.fn().mockResolvedValue([]) },
      photo: { findMany: vi.fn().mockResolvedValue([]) },
    },
  }));
  vi.doMock("@/lib/safe-fetch", () => ({ guardedFetch }));
  vi.doMock("@/lib/fedi-resolve", () => ({ resolveFediActorByUri }));
  vi.doMock("@/lib/blocks", () => ({ isBlockedSender }));
  vi.doMock("@/lib/fedi-media", () => ({
    processAttachments: vi.fn().mockResolvedValue({ urls: [], types: [], remotes: [] }),
    fetchLinkEmbed: vi.fn().mockResolvedValue(null),
    removeFediMediaFiles,
  }));
  vi.doMock("@/lib/site-settings", () => ({
    getRuntimeSiteConfig: vi.fn().mockResolvedValue({ explore: h.settings }),
  }));
  vi.doMock("@/lib/identity", () => ({ getSiteUrl: () => "https://mine.example" }));

  const mod = await import("@/lib/explore");
  mod.resetExploreMissCache();
  return { mod, upsert, deleteMany, count, guardedFetch, isBlockedSender, removeFediMediaFiles, fediPostFindMany };
}

beforeEach(() => vi.resetModules());

describe("isPublicNote", () => {
  it("accepts a post addressed to the public collection, in `to` or `cc`", async () => {
    const { mod } = await load();
    expect(mod.isPublicNote({ to: [PUBLIC] })).toBe(true);
    expect(mod.isPublicNote({ cc: [PUBLIC] })).toBe(true);
    expect(mod.isPublicNote({ to: PUBLIC })).toBe(true); // string, not array
  });

  it("rejects followers-only and direct posts", async () => {
    const { mod } = await load();
    expect(mod.isPublicNote({ to: ["https://friend.example/users/ada/followers"] })).toBe(false);
    expect(mod.isPublicNote({ to: ["https://mine.example/ap/actor"] })).toBe(false);
    expect(mod.isPublicNote({})).toBe(false);
  });
});

describe("resolveReplyParents — what it refuses to store", () => {
  it("does nothing at all when Explore is off", async () => {
    const { mod, guardedFetch, upsert } = await load({
      settings: { enabled: false, replyParents: true, lookbackDays: 7, maxStored: 500 },
    });
    await mod.resolveReplyParents();
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does nothing when the reply-parent signal specifically is off", async () => {
    // Boosts still work with this off — they need no fetching. This switch is
    // about whether we make requests to other people's servers.
    const { mod, guardedFetch } = await load({
      settings: { enabled: true, replyParents: false, lookbackDays: 7, maxStored: 500 },
    });
    await mod.resolveReplyParents();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("refuses a post that isn't addressed to the public", async () => {
    // The whole feature is built on other people's replies, and a followers-only
    // post from a stranger is not ours to store however public the reply was.
    const { mod, upsert } = await load({
      json: note({ to: ["https://elsewhere.example/users/mallory/followers"] }),
    });
    const r = await mod.resolveReplyParents();
    expect(upsert).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it("refuses a post whose AUTHOR is blocked, not just whose replier is", async () => {
    // #353 is the precedent and this is the same shape: the person we follow is
    // not blocked, so nothing upstream catches it. Here there is no sender at
    // all — we went and asked for the post — so this check is the only one.
    const { mod, upsert, isBlockedSender } = await load({ blocked: [STRANGER] });
    const r = await mod.resolveReplyParents();
    expect(isBlockedSender).toHaveBeenCalledWith(STRANGER);
    expect(upsert).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it("checks the block BEFORE fetching the author's profile or their media", async () => {
    // A blocked person's avatar in the media cache is the same leak as their
    // post in the feed; ordering is the whole of the fix.
    const { mod, isBlockedSender } = await load({ blocked: [STRANGER] });
    const { resolveFediActorByUri } = (await import("@/lib/fedi-resolve")) as unknown as {
      resolveFediActorByUri: ReturnType<typeof vi.fn>;
    };
    await mod.resolveReplyParents();
    expect(isBlockedSender).toHaveBeenCalled();
    expect(resolveFediActorByUri).not.toHaveBeenCalled();
  });

  it("refuses anything that isn't a Note or an Article", async () => {
    const { mod, upsert } = await load({ json: note({ type: "Video" }) });
    await mod.resolveReplyParents();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("never fetches a parent that is one of our own posts", async () => {
    const { mod, guardedFetch } = await load({
      replies: [{ inReplyTo: "https://mine.example/post/hello" }],
    });
    await mod.resolveReplyParents();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("never fetches a parent we already hold", async () => {
    const { mod, guardedFetch } = await load({ have: [PARENT] });
    await mod.resolveReplyParents();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("does nothing when the owner follows nobody", async () => {
    // `actorUri: { in: [] }` would match no rows anyway, but bailing early keeps
    // a fresh instance from running the whole scan on every tick forever.
    const { mod, guardedFetch } = await load({ following: [] });
    await mod.resolveReplyParents();
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});

describe("resolveReplyParents — what it does store", () => {
  it("marks the row so it can never be mistaken for feed content", async () => {
    const { mod, upsert } = await load();
    const r = await mod.resolveReplyParents();
    expect(r.stored).toBe(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ apId: PARENT });
    expect(arg.create).toMatchObject({
      actorUri: STRANGER,
      apId: PARENT,
      discoveredVia: "reply-parent",
      username: "mallory",
      domain: "elsewhere.example",
    });
  });

  it("does not promote or demote a row that arrived some other way meanwhile", async () => {
    // Raced with a delivery between the "do we have it?" probe and the write.
    // Whatever wrote it first knows more about its provenance than we do.
    const { mod, upsert } = await load();
    await mod.resolveReplyParents();
    expect(upsert.mock.calls[0][0].update).toEqual({});
  });

  it("only follows up replies from people the owner actually follows", async () => {
    const { mod, fediPostFindMany } = await load();
    await mod.resolveReplyParents();
    const scan = fediPostFindMany.mock.calls[0][0].where;
    expect(scan.actorUri).toEqual({ in: [FOLLOWED] });
    // …and the scan itself must not pick up rows that are already Explore
    // content, or the feature would walk its own output.
    expect(scan.discoveredVia).toBeNull();
    expect(scan.viaLookup).toBe(false);
    expect(scan.boostedBy).toBeNull();
  });

  it("caps outbound fetches per run however many candidates there are", async () => {
    // Each fetch is a request to a server that never asked to hear from us.
    const many = Array.from({ length: 50 }, (_, i) => ({
      inReplyTo: `https://elsewhere.example/notes/${i}`,
    }));
    const { mod, guardedFetch } = await load({ replies: many });
    await mod.resolveReplyParents();
    expect(guardedFetch.mock.calls.length).toBe(10);
  });
});

describe("resolveReplyParents — the miss cache", () => {
  it("does not re-fetch a parent that already failed", async () => {
    // Without this a permanently-dead parent is retried every run for as long as
    // the reply pointing at it stays in the lookback window — and it crowds out
    // live candidates, because the per-run budget is deliberately small.
    const { mod, guardedFetch } = await load({ ok: false });
    await mod.resolveReplyParents();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    await mod.resolveReplyParents();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("expires, so a server that was briefly down is tried again", async () => {
    const { mod, guardedFetch } = await load({ ok: false });
    const t0 = new Date("2026-08-02T00:00:00.000Z");
    await mod.resolveReplyParents(t0);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    await mod.resolveReplyParents(new Date(t0.getTime() + 7 * 60 * 60_000));
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it("remembers a refusal too, not just an unreachable server", async () => {
    // A followers-only parent will still be followers-only next hour.
    const { mod, guardedFetch } = await load({ json: note({ to: ["private"] }) });
    await mod.resolveReplyParents();
    await mod.resolveReplyParents();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("pruneExploreOverflow", () => {
  const overflowRows = [
    { id: "a", mediaUrls: ["/uploads/fedi/a.jpg"] },
    { id: "b", mediaUrls: [] },
  ];

  async function withOverflow(maxStored: number, total: number) {
    const { mod, deleteMany, count, removeFediMediaFiles } = await load();
    count.mockResolvedValue(total);
    const { prisma } = (await import("@/lib/db")) as unknown as {
      prisma: { fediPost: { findMany: ReturnType<typeof vi.fn> } };
    };
    prisma.fediPost.findMany.mockResolvedValue(overflowRows);
    deleteMany.mockResolvedValue({ count: overflowRows.length });
    const pruned = await mod.pruneExploreOverflow(maxStored);
    return { pruned, deleteMany, removeFediMediaFiles, findMany: prisma.fediPost.findMany };
  }

  it("deletes the oldest past the cap, and their cached media with them", async () => {
    // A cap that bounds the table and leaves the disk growing is the half-fix
    // that makes a limit feel like it isn't working.
    const { pruned, deleteMany, removeFediMediaFiles, findMany } = await withOverflow(500, 502);
    expect(pruned).toBe(2);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { discoveredVia: "reply-parent" },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    expect(deleteMany.mock.calls[0][0].where).toEqual({ id: { in: ["a", "b"] } });
    expect(removeFediMediaFiles).toHaveBeenCalledWith(["/uploads/fedi/a.jpg"]);
  });

  it("is scoped to reply-parents — boosted posts are ordinary ingest", async () => {
    const { findMany } = await withOverflow(500, 502);
    expect(findMany.mock.calls[0][0].where.discoveredVia).toBe("reply-parent");
  });

  it("does nothing under the cap, and nothing at all when the cap is 0", async () => {
    const { mod, deleteMany, count } = await load();
    count.mockResolvedValue(10);
    expect(await mod.pruneExploreOverflow(500)).toBe(0);
    expect(await mod.pruneExploreOverflow(0)).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * The read side. A reply-parent is a thread ROOT: no inReplyTo, no boostedBy,
 * not viaLookup. Every clause the feeds already had passes it, so `discoveredVia`
 * is the only thing standing between Explore and the page the owner shows the
 * world — which is precisely the situation #460 was.
 */
describe("#386 — no timeline-shaped read shows Explore content", () => {
  const TIMELINE_READS = [
    "src/app/(public)/fediverse/page.tsx",
    "src/app/timeline/page.tsx",
    "src/app/api/feed/route.ts",
  ];

  for (const file of TIMELINE_READS) {
    it(`${file} excludes discoveredVia rows`, () => {
      expect(/discoveredVia(:|\s*=)\s*null/.test(read(file))).toBe(true);
    });
  }

  it("the public page's where-clause carries all five gates together", () => {
    const src = read("src/app/(public)/fediverse/page.tsx");
    const where = src.slice(src.indexOf("where: {"), src.indexOf("orderBy"));
    for (const clause of [
      "inReplyTo: null", "boostedBy: null", "viaLookup: false", "discoveredVia: null",
      "blockedPostFilter",
    ]) {
      expect(where.includes(clause), `public feed where-clause is missing ${clause}`).toBe(true);
    }
  });

  it("/api/feed excludes it unconditionally, not behind a query flag", () => {
    // This route is the ONLY one a native app reads, so a flag the app forgot to
    // send would mean its feed and the web feed disagreed about what a feed is.
    // The other optional clauses in that handler sit inside `if (…) {` and are
    // indented four spaces; an unconditional one is at body level with two.
    const src = read("src/app/api/feed/route.ts");
    const line = src.split("\n").find((l) => l.includes("where.discoveredVia"));
    expect(line, "/api/feed never sets where.discoveredVia").toBeDefined();
    expect(line).toBe("  where.discoveredVia = null;");
  });

  it("the Explore route nests its OR under AND, so a cursor can't clobber it", () => {
    // `cursorWhere` contributes a top-level OR. A second top-level OR would
    // silently overwrite the first — and only from page two onwards, which is
    // the worst way to find out.
    const src = read("src/app/api/explore/route.ts");
    expect(src).toContain("AND: [{ OR: [{ boostedBy: { not: null } }, { discoveredVia: { not: null } }] }]");
  });

  it("the Explore route keeps the boostedBy leg, so an upgrade isn't empty", () => {
    // Boost rows written before this column existed carry NULL. They are the
    // whole of what Explore has to show on day one.
    const src = read("src/app/api/explore/route.ts");
    expect(src).toContain("boostedBy: { not: null }");
  });

  it("the Explore route is gated on the setting, and 404s rather than emptying", () => {
    const src = read("src/app/api/explore/route.ts");
    expect(src).toMatch(/site\.explore\.enabled/);
    expect(src).toMatch(/status:\s*404/);
  });
});
