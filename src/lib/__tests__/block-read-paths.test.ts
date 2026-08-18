import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * The balanced `{...}` argument of the call starting on the first line of `src`.
 * Falls back to the whole remainder if braces don't balance, so a parse failure
 * can never turn into a false PASS.
 */
function callArgs(src: string): string {
  const start = src.indexOf("{");
  if (start === -1) return src;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return src;
}

/** Reads federated posts and shows them to someone. */
const USER_FACING_READS = [
  "src/app/api/feed/route.ts", //                  the app + web timeline
  "src/app/api/conversation/route.ts", //           thread views
  "src/app/timeline/page.tsx", //                   owner timeline, SSR
  "src/app/(public)/fediverse/page.tsx", //         public page — renders to strangers
  "src/app/api/explore/route.ts", //                Explore tab (#386) — was in NEITHER list
  "src/app/api/fedi-post-counts/route.ts", //       like/boost counts, and it FETCHES (#559)
  "src/app/api/replies/route.ts", //                was EXEMPT, wrongly — its parent summary
];

/**
 * Reads `fediPost` without a block check, and why.
 *
 * BE CLEAR ABOUT WHAT THIS ENFORCES, because overstating it is how the previous
 * version failed. It does NOT prove these are safe. `_actions/replies.ts` alone
 * holds four reads — an `isOutgoing` list, an id lookup checked for ownership,
 * an ancestor walk selecting only `inReplyTo`, and a scan of other people's
 * replies to our posts — and no pattern separates "walks a chain" from "renders
 * a stranger's words". The old check pretended otherwise, testing whole files
 * for the string `isOutgoing`, which is precisely how /api/replies inherited a
 * justification belonging to a different query (#559).
 *
 * What it does enforce is that the list is CLOSED: combined with the sweep
 * below, a new file reading fediPost cannot be silently unguarded — someone has
 * to classify it and write down why. That is a real guarantee, and a smaller one
 * than it looks.
 */
const EXEMPT: Record<string, string> = {
  "src/app/(public)/post/[slug]/page.tsx": "isOutgoing: true — our own replies, blocks don't apply to us",
  "src/app/api/admin/_actions/replies.ts": "own replies, plus an inReplyTo-only ancestor walk — nothing rendered",
  "src/app/api/admin/_actions/fedi-graph.ts": "admin-only graph management",
  "src/app/ap/inbox/route.ts": "ingest — dedup by apId, ownership comparison, our-post lookup",
  "src/app/api/admin/_actions/fedi-interactions.ts": "selects actorUri only, to address a like/boost the owner initiated",
  "src/app/api/admin/_actions/interactions.ts": "selects source/apId/bskyUri only, to route an interaction",
  "src/app/api/profile/route.ts": "selects actorUri only — identity resolution, no post content",
  "src/app/api/admin/_actions/bluesky-interactions.ts":
    "selects username only, to hand the handle to the block check itself (#563)",
};

describe("read-side block filtering", () => {
  it.each(USER_FACING_READS)("%s applies a block check", (rel) => {
    // Not blockedPostFilter by name: a single-row read cannot use a `where`
    // filter (see the window comment below), so /api/fedi-post-counts checks the
    // returned row with blockedActorUris instead. Both are correct.
    expect(read(rel)).toMatch(/blockedPostFilter|blockedActorUris|isBlockedSender/);
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
        // findUnique and findFirst too (#559). Matching findMany alone made the
        // two single-row reads in /api/conversation invisible to this guard, and
        // both of them were returning blocked authors' posts.
        if (!/fediPost\.(findMany|findUnique|findFirst)/.test(line)) return;
        // Both directions: the filter is spread into the `where` literal in some
        // routes and assigned onto a built-up `where` object just above the query
        // in others. Both are correct; only "nowhere near this read" is not.
        //
        // Forward half is the call's OWN argument object, matched by brace
        // balance rather than a fixed line count. A fixed count silently gets
        // too tight the moment a where-clause grows a line — which is exactly
        // what #460 did to it, turning a real guard into a formatting tripwire.
        //
        // The forward half also runs PAST the call, and that is not slack (#559).
        // A single-row read cannot be fixed with a `where` filter: for the
        // ancestor walk, filtering to nothing is indistinguishable from
        // "not cached", and the next line would then fetch from the blocked
        // actor's own server — the outbound contact #379 closed. The only
        // correct fix there is a check on the RETURNED ROW, which sits below the
        // call. A window that stopped at the argument object would reject it.
        // Twenty lines because those fixes carry their reasoning with them, and
        // a window too tight to hold the comment is a formatting tripwire — the
        // failure mode #460 already inflicted on the backward half.
        //
        // BUT BOUNDED AT THE NEXT READ, in both directions, and that bound is
        // what makes the widening safe. Without it the window reaches into a
        // neighbouring query and borrows ITS filter: on the pre-fix tree the
        // unguarded findUnique at conversation:28 sits ten lines above a
        // correctly-filtered findMany, so a merely-wider window would have
        // declared the exact bug this guard was rebuilt to catch a pass.
        const isRead = (l: string) => /fediPost\.(findMany|findUnique|findFirst)/.test(l);
        let from = Math.max(0, i - 10);
        for (let k = i - 1; k >= from; k--) if (isRead(lines[k])) { from = k + 1; break; }
        let to = Math.min(lines.length, i + 20);
        for (let k = i + 1; k < to; k++) if (isRead(lines[k])) { to = k; break; }

        const rest = lines.slice(i, to).join("\n");
        const window =
          lines.slice(from, i).join("\n") +
          "\n" +
          callArgs(rest) +
          "\n" +
          lines.slice(i + 1, to).join("\n");
        // `isOutgoing` counts HERE, per call site — a file can legitimately mix
        // its own content with other people's, and /api/replies does exactly
        // that: our replies in one query, their parents in the next. That was
        // never wrong as reasoning; it was wrong applied to a whole FILE, which
        // let the second query inherit the first one's justification (#559).
        expect(
          /blockedPostFilter|blockFilter|blockedActorUris|isBlockedSender|isOutgoing/.test(window),
          `${rel}:${i + 1} reads fediPost with no block check and no isOutgoing near it`,
        ).toBe(true);
      });
    }
  });

  it("every exemption carries a written reason and names a real file", () => {
    // Deliberately not asserting anything about the CODE — see the note on
    // EXEMPT. A check that cannot distinguish the safe case from the unsafe one
    // is worse than none, because it reads as coverage.
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${rel} needs a reason`).toBeGreaterThan(10);
      expect(read(rel).length, `${rel} is listed but does not exist`).toBeGreaterThan(0);
    }
  });

  /**
   * The lists above were hand-written, and nothing checked they were complete —
   * which is the deepest of the three blind spots #559 exposed. `/api/explore`
   * and `/api/fedi-post-counts` both read fediPost and appeared in NEITHER list,
   * so they were guarded by nothing at all. Explore happened to filter
   * correctly; fedi-post-counts did not, and was contacting blocked servers.
   *
   * A sweep is what turns this from a list somebody remembers to update into a
   * guard. A new route that reads fediPost now fails here until it is classified.
   */
  it("every file reading fediPost is classified, so none is guarded by nothing", () => {
    const seen = new Set([...USER_FACING_READS, ...Object.keys(EXEMPT)]);
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${entry}`;
        if (statSync(join(ROOT, rel)).isDirectory()) {
          if (entry === "__tests__") continue;
          walk(rel);
        } else if (/\.tsx?$/.test(entry) && /prisma\.fediPost\.(findMany|findUnique|findFirst)/.test(read(rel))) {
          readers.push(rel);
        }
      }
    };
    walk("src/app");
    const unclassified = readers.filter((r) => !seen.has(r));
    expect(
      unclassified,
      "these read fediPost but are in neither USER_FACING_READS nor EXEMPT — classify them",
    ).toEqual([]);
  });
});

/**
 * Every `isBlueskyBlocked` call passes a handle (#563).
 *
 * The helper's signature makes the handle OPTIONAL — `{ did: string; handle?:
 * string | null }` — and that optionality is load-bearing in the wrong
 * direction: omitting it doesn't fail, it silently skips the `blockedDomain`
 * query, so a domain block degrades to a DID lookup and nobody finds out.
 *
 * There were two call sites. Ingest passed both; the outbound one passed only
 * the DID, so blocking a domain stopped their posts arriving and did not stop
 * us liking them — and a like notifies the author. A third call site is exactly
 * as easy to get wrong, which is why this is structural rather than a comment
 * on the helper.
 */
describe("#563 — no Bluesky block check drops the handle", () => {
  it("every isBlueskyBlocked call site passes a handle", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${entry}`;
        if (statSync(join(ROOT, rel)).isDirectory()) {
          if (entry === "__tests__" || entry === "generated") continue;
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || rel === "src/lib/blocks.ts") continue;
        const lines = read(rel).split("\n");
        lines.forEach((line, i) => {
          if (!/isBlueskyBlocked\(/.test(line) || /^\s*(\*|\/\/)/.test(line)) return;
          // The argument object can wrap, so look at the call plus a few lines.
          const window = lines.slice(i, i + 6).join("\n");
          if (!/handle:/.test(window)) offenders.push(`${rel}:${i + 1}`);
        });
      }
    };
    walk("src");
    expect(
      offenders,
      "these ask isBlueskyBlocked with a DID only, so a domain block will not apply",
    ).toEqual([]);
  });
});
