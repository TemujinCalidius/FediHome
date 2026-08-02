import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * #478. trimFediStorage unlinked cached files and changed nothing else. The
 * remote original was discarded at proxy time, so every post referencing an
 * evicted file rendered a broken image, permanently, with no way to re-fetch.
 *
 * Eviction is by AGE, so it took the oldest media first — posts far enough down
 * the timeline that nobody scrolls to them today. The breakage appeared
 * gradually, in old posts, long after the trim that caused it. It gets sharper
 * with #364: an operator who LOWERS the budget triggers a large eviction
 * immediately, which is exactly the moment they'd least connect the two.
 */
describe("processAttachments records the original URL (#478)", () => {
  const src = read("src/lib/fedi-media.ts");

  it("returns a remotes array alongside urls and types", () => {
    expect(src).toContain("remotes: string[]");
    expect(src).toContain("return { urls, types, remotes };");
  });

  it("pushes a remote on EVERY branch, not just the proxied ones", () => {
    // A parallel array that is sometimes short is worse than no array: the
    // restore pairs by index, so one missing entry silently shifts every
    // attachment after it onto the wrong original.
    const body = src.slice(src.indexOf("export async function processAttachments"));
    const fn = body.slice(0, body.indexOf("\n}"));
    const pushesUrl = (fn.match(/urls\.push\(/g) ?? []).length;
    const pushesRemote = (fn.match(/remotes\.push\(/g) ?? []).length;
    expect(pushesRemote).toBeGreaterThan(0);
    // One remote push per branch, and there are fewer branches than url pushes
    // only if a branch was missed.
    expect(fn).toContain("remotes.push(url);");
    expect(pushesUrl).toBeGreaterThanOrEqual(pushesRemote);
  });
});

describe("every ingest site stores it (#478)", () => {
  const SITES = [
    "src/app/ap/inbox/route.ts",
    "src/app/api/conversation/route.ts",
    "src/app/api/admin/_actions/fedi-graph.ts",
  ];

  for (const file of SITES) {
    it(`${file} writes mediaRemoteUrls wherever it writes mediaTypes`, () => {
      // Pairing on mediaTypes rather than counting: the two are parallel arrays
      // written together, so a write with one and not the other is the bug.
      const src = read(file);
      const withTypes = (src.match(/^\s*mediaTypes,$/gm) ?? []).length;
      const withRemotes = (src.match(/^\s*mediaRemoteUrls,$/gm) ?? []).length;
      expect(withRemotes).toBe(withTypes);
    });
  }

  it("the edit path updates the remotes too", () => {
    // An Update replaces the attachments; leaving the old remotes behind would
    // point a future eviction at the wrong originals.
    const src = read("src/app/ap/inbox/route.ts");
    expect(src).toMatch(/data: \{ content, contentHtml: content, mediaUrls, mediaTypes, mediaRemoteUrls, editedAt \}/);
  });
});

describe("restoreEvictedMedia — the behaviour that matters", () => {
  const load = async (rows: unknown[]) => {
    vi.resetModules();
    const update = vi.fn();
    vi.doMock("@/lib/db", () => ({
      prisma: { fediPost: { findMany: vi.fn().mockResolvedValue(rows), update } },
    }));
    vi.doMock("@/lib/uploads-dir", () => ({
      uploadsRoots: async () => ["/srv/up"],
      uploadsDir: async () => "/srv/up",
      legacyUploadsDir: () => "/srv/up",
      ensureUploadDir: vi.fn(),
      resolveUploadPath: vi.fn(),
      uploadPathFor: vi.fn(),
      fediCacheBudgetBytes: async () => 0,
      remoteMediaCachingEnabled: async () => false,
    }));
    return { update };
  };
  beforeEach(() => vi.resetModules());

  it("is wired into the trim, not merely defined", () => {
    const src = read("src/lib/fedi-media.ts");
    expect(src).toContain("await restoreEvictedMedia(evicted)");
    // Only when something was actually removed — an empty sweep must not query.
    expect(src).toContain("if (evicted.length > 0)");
  });

  it("skips a row whose parallel arrays disagree", () => {
    // Half-rewriting by index would pair a URL with another attachment's
    // original — worse than the broken image it is replacing.
    const src = read("src/lib/fedi-media.ts");
    expect(src).toContain("row.mediaRemoteUrls.length !== row.mediaUrls.length");
  });

  it("leaves pre-migration rows alone rather than blanking them", () => {
    // They have nothing to restore FROM. Writing "" would replace a broken image
    // with a missing one AND destroy the record that there was an image.
    const src = read("src/lib/fedi-media.ts");
    expect(src).toContain("row.mediaRemoteUrls[i] ? row.mediaRemoteUrls[i] : u");
  });

  it("matches on the stored /uploads URL, so it works across both roots", () => {
    // A file under the legacy root (#479) is served from the same /uploads URL,
    // so matching the path would miss exactly the stranded cache.
    const src = read("src/lib/fedi-media.ts");
    expect(src).toContain('p.lastIndexOf("/uploads/")');
  });

  it("never lets a database failure fail the sweep", () => {
    // The files are already gone; throwing here would abort the trim and leave
    // the cache over budget on top of the broken images.
    const src = read("src/lib/fedi-media.ts");
    const fn = src.slice(src.indexOf("async function restoreEvictedMedia"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("catch");
  });
});

describe("the migration is honest about what it can't do (#478)", () => {
  const sql = read("prisma/manual-migrations/2026-08-02-fedipost-media-remote-urls.sql");

  it("is additive and idempotent", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
  });

  it("says why there is no backfill", () => {
    // The URL was discarded at proxy time — there is nothing to backfill from,
    // and claiming otherwise would be worse than the gap.
    expect(sql).toMatch(/No backfill/i);
  });
});
