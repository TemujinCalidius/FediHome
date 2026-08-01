import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every read path that returns federated posts to a person applies the block filter.
 *
 * Blocking in FediHome is enforced at ingest (#396, #397) *and* on the way out,
 * because ingest can only stop what hasn't arrived yet — a purge that half-failed,
 * a thread re-import, a row that predates the block. The read-side filter is what
 * makes the guarantee hold regardless.
 *
 * It kept drifting. `/timeline` and `/fediverse` filtered; `/api/feed` did not, so
 * the SSR first paint hid a blocked account and every client refetch brought it
 * back (#459). `/api/conversation` filtered its Bluesky branch and not its
 * ActivityPub one — the same thread, two different answers depending on which
 * network the post came from.
 *
 * Both are one-line omissions in a `where` clause, invisible in review and
 * invisible in every other test. So this asserts the structural property instead:
 * if a file reads `fediPost` for display, it references the filter.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

/** Reads federated posts and shows them to someone. */
const USER_FACING_READS = [
  "src/app/api/feed/route.ts", //                  the app + web timeline
  "src/app/api/conversation/route.ts", //           thread views
  "src/app/timeline/page.tsx", //                   owner timeline, SSR
  "src/app/(public)/fediverse/page.tsx", //         public page — renders to strangers
];

/**
 * Reads `fediPost` but doesn't need the filter, with the reason. Listed
 * explicitly so a new unfiltered read has to be argued for rather than
 * accidentally matching a loose pattern.
 */
const EXEMPT: Record<string, string> = {
  "src/app/(public)/post/[slug]/page.tsx": "isOutgoing: true — our own replies, blocks don't apply to us",
  "src/app/api/replies/route.ts": "admin-only, isOutgoing: true — our own replies",
  "src/app/api/admin/_actions/replies.ts": "admin-only, isOutgoing / apId bookkeeping",
  "src/app/api/admin/_actions/fedi-graph.ts": "admin-only graph management",
};

describe("read-side block filtering", () => {
  it.each(USER_FACING_READS)("%s applies blockedPostFilter", (rel) => {
    expect(read(rel)).toContain("blockedPostFilter");
  });

  it("applies it to EVERY fediPost read in those files, not just the first", () => {
    // /api/conversation is exactly why this is per-call-site rather than per-file:
    // it had the filter on its Bluesky branch and not its ActivityPub one, so any
    // file-level "does this file mention the filter" check would have passed it.
    //
    // Matches either a direct call or a hoisted variable holding the result — one
    // lookup reused across sibling queries is better code, not a missing filter.
    for (const rel of USER_FACING_READS) {
      const lines = read(rel).split("\n");
      lines.forEach((line, i) => {
        if (!/fediPost\.findMany/.test(line)) return;
        // Both directions: the filter is spread into the `where` literal in some
        // routes and assigned onto a built-up `where` object just above the query
        // in others. Both are correct; only "nowhere near this read" is not.
        const window = lines.slice(Math.max(0, i - 10), i + 6).join("\n");
        expect(
          /blockedPostFilter|blockFilter/.test(window),
          `${rel}:${i + 1} reads fediPost with no block filter in its where clause`,
        ).toBe(true);
      });
    }
  });

  it("keeps the exempt list honest about why each one is exempt", () => {
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      const src = read(rel);
      expect(reason.length, `${rel} needs a reason`).toBeGreaterThan(10);
      // Each exemption rests on the read being our own content or admin-gated.
      const ownContent = src.includes("isOutgoing");
      const adminOnly = src.includes("verifyAdmin") || rel.includes("/admin/");
      expect(ownContent || adminOnly, `${rel} is neither own-content nor admin-gated`).toBe(true);
    }
  });
});
