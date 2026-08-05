import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * #460. A thread root has no inReplyTo and nothing sets boostedBy on it, so an
 * ingested thread root matched the public feed's query verbatim — one curious
 * click published a stranger's post under the owner's domain, permanently.
 *
 * Two halves, and BOTH have to hold: every on-demand ingest must MARK the row,
 * and every timeline-shaped read must FILTER on the mark. Either half alone is
 * useless, which is why they are asserted together.
 */
describe("#460 — on-demand ingests are marked as lookups", () => {
  // Sites that fetch someone else's posts because the OWNER looked at
  // something, rather than because the post was delivered to their feed.
  const LOOKUP_INGESTS: Record<string, string> = {
    "src/app/api/conversation/route.ts": "thread context + ancestor walk",
    "src/app/api/admin/_actions/fedi-graph.ts": "remote profile outbox",
  };

  for (const [file, why] of Object.entries(LOOKUP_INGESTS)) {
    it(`${file} sets viaLookup on create (${why})`, () => {
      const src = read(file);
      // Scoped to fediPost writes on purpose: these files also upsert
      // FediFollowing rows, which have no provenance column and never should.
      const writes = src.split(/prisma\.fediPost\.(?:upsert|create)\(/).slice(1);
      expect(writes.length, `${file} has no fediPost write`).toBeGreaterThan(0);
      for (const [i, write] of writes.entries()) {
        const create = write.slice(write.indexOf("create: {"));
        expect(
          /viaLookup:\s*true/.test(create.slice(0, 2500)),
          `${file}: fediPost write #${i + 1} does not set viaLookup — an unmarked ` +
            `thread root reaches the public page`,
        ).toBe(true);
      }
    });
  }

  it("the conversation route marks BOTH of its ingests, not just one", () => {
    // fetchThreadViaMastodon and fetchRemoteNote are separate code paths that
    // both write rows; fixing only the Mastodon one leaves non-Mastodon servers
    // leaking through the ancestor walk.
    const src = read("src/app/api/conversation/route.ts");
    expect(src.match(/viaLookup:\s*true/g)?.length).toBe(2);
  });

  it("does not demote a delivered row when a thread is later expanded", () => {
    // The update branch must NOT carry viaLookup: true, or opening a thread
    // would hide a post the owner already legitimately had in their feed.
    const src = read("src/app/api/conversation/route.ts");
    for (const block of src.split(/\bupdate:\s*\{/).slice(1)) {
      expect(/viaLookup:\s*true/.test(block.slice(0, 400))).toBe(false);
    }
  });

  it("inbox delivery promotes a lookup row back into the feed", () => {
    // Delivery is proof the post belongs in the timeline. Without this, a post
    // first seen by expanding a thread stays hidden forever after it arrives.
    //
    // BOTH provenance marks have to be cleared, not just this one (#386): a row
    // the Explore resolver fetched as someone's reply-parent carries
    // discoveredVia instead, and clearing only viaLookup would leave a delivered
    // post stuck on Explore. Asserted as two independent matches rather than one
    // literal so the order of the two keys is free.
    const src = read("src/app/ap/inbox/route.ts");
    const update = src.slice(src.indexOf("update: { viaLookup"));
    expect(update.slice(0, 120)).toMatch(/viaLookup:\s*false/);
    expect(update.slice(0, 120)).toMatch(/discoveredVia:\s*null/);
  });
});

describe("#460 — every timeline-shaped read filters on provenance", () => {
  // The three that answer "top-level posts in the feed". They must agree: the
  // v1.23.0 regression and #459 were both SSR and /api/feed disagreeing about
  // the same list, visible only once something refetched.
  const TIMELINE_READS = [
    "src/app/(public)/fediverse/page.tsx",
    "src/app/timeline/page.tsx",
    "src/app/api/feed/route.ts",
  ];

  for (const file of TIMELINE_READS) {
    it(`${file} excludes viaLookup rows`, () => {
      expect(/viaLookup(:|\s*=)\s*false/.test(read(file))).toBe(true);
    });
  }

  it("the public page filters provenance AND blocks together", () => {
    // The public page is the one that renders to strangers, so assert its whole
    // where clause rather than just the presence of a token.
    const src = read("src/app/(public)/fediverse/page.tsx");
    const where = src.slice(src.indexOf("where: {"), src.indexOf("orderBy"));
    for (const clause of ["inReplyTo: null", "boostedBy: null", "viaLookup: false", "blockedPostFilter"]) {
      expect(where.includes(clause), `public feed where-clause is missing ${clause}`).toBe(true);
    }
  });

  it("the conversation route does NOT filter it — thread views are the point", () => {
    // The rows are still fetched and stored; they are simply not feed content.
    // If this ever starts filtering, expanding a thread shows nothing but the
    // owner's own replies.
    const src = read("src/app/api/conversation/route.ts");
    for (const block of src.split(/\bwhere:\s*\{/).slice(1)) {
      expect(/viaLookup/.test(block.slice(0, 200))).toBe(false);
    }
  });
});

describe("#460 — the thread-context map covers everything it ingests", () => {
  it("slices ancestors and descendants the same way the ingest does", () => {
    // The map was built from the first MAX_CONTEXT of anc+desc while the ingest
    // took MAX_CONTEXT of EACH. Statuses past the end of the map failed their
    // idToUri lookup, fell back to inReplyTo: null, and landed as TOP-LEVEL
    // rows — the exact shape that reaches the public page.
    const src = read("src/app/api/conversation/route.ts");
    expect(src).toContain(
      "const all = [...(anc || []).slice(0, MAX_CONTEXT), ...(desc || []).slice(0, MAX_CONTEXT)];",
    );
    expect(src).not.toContain("const all = [...(anc || []), ...(desc || [])].slice(0, MAX_CONTEXT);");
  });
});

describe("#460 — the backfill runs once and is biased toward hiding", () => {
  beforeEach(() => vi.resetModules());

  const load = async (existing: unknown, updateMany = vi.fn().mockResolvedValue({ count: 3 })) => {
    const siteSetting = { findUnique: vi.fn().mockResolvedValue(existing), upsert: vi.fn() };
    const fediFollowing = { findMany: vi.fn().mockResolvedValue([{ actorUri: "https://a.example/u/x" }]) };
    vi.doMock("@/lib/db", () => ({ prisma: { siteSetting, fediFollowing, fediPost: { updateMany } } }));
    const mod = await import("@/lib/lookup-backfill");
    return { mod, siteSetting, updateMany };
  };

  it("does nothing when the setting already records a run", async () => {
    const { mod, updateMany } = await load({ key: "migrations.viaLookupBackfill", value: "7" });
    expect(await mod.backfillViaLookup()).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("scopes to fedi rows so the Bluesky half of the feed is not blanked", async () => {
    // Bluesky rows keep a DID in actorUri; FediFollowing holds https URIs, so an
    // unscoped notIn matches every Bluesky row.
    const { mod, updateMany } = await load(null);
    await mod.backfillViaLookup();
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      viaLookup: false,
      source: "fedi",
      isOutgoing: false,
      boostedBy: null,
      actorUri: { notIn: ["https://a.example/u/x"] },
    });
    expect(updateMany.mock.calls[0][0].data).toEqual({ viaLookup: true });
  });

  it("records the run only after the update succeeds", async () => {
    // A crash mid-backfill must retry, not record a run that did not finish.
    const failing = vi.fn().mockRejectedValue(new Error("db down"));
    const { mod, siteSetting } = await load(null, failing);
    await expect(mod.backfillViaLookup()).rejects.toThrow("db down");
    expect(siteSetting.upsert).not.toHaveBeenCalled();
  });

  it("records the run when it does succeed, so it never fires twice", async () => {
    const { mod, siteSetting } = await load(null);
    expect(await mod.backfillViaLookup()).toBe(3);
    expect(siteSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "migrations.viaLookupBackfill" } }),
    );
  });
});
