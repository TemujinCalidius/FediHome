import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Every outbound path that takes a remote-controlled URL goes through the shared
 * guard — not a bare `fetch()`.
 *
 * This is the test that would have caught the original bug across all nine sites at
 * once. It asserts the *structural* property rather than each site's behaviour:
 * `guardedFetch` is the only thing that follows a redirect safely, so a call site
 * using plain `fetch()` on a remote URL is by definition unguarded, however careful
 * its up-front `assertPublicHost` call looks.
 *
 * Kept as source inspection deliberately. The alternative — standing up a redirect
 * server per call site — needs each one's full mock scaffolding (Prisma, auth,
 * signatures) and would test nine copies of one property. This states the property
 * once, and a new unguarded `fetch()` fails it on the next run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/**
 * Files that fetch a URL somebody else chose: an actor URI out of an inbox
 * activity, a keyId from a signature, an inbox from a fetched actor document, a
 * handle typed by the owner.
 */
const REMOTE_URL_FETCHERS = [
  "src/lib/http-signatures.ts",
  "src/lib/fedi-resolve.ts",
  "src/lib/fedi-media.ts",
  "src/lib/peertube.ts",
  "src/app/ap/inbox/route.ts",
  "src/app/api/conversation/route.ts",
  "src/app/api/profile/route.ts",
  "src/app/api/fedi-post-counts/route.ts",
  "src/app/api/admin/_actions/fedi-graph.ts",
];

/** Fetches whose URL is a fixed first-party API base, so no attacker picks it. */
const FIRST_PARTY_ONLY = ["src/lib/tinylytics.ts", "src/lib/integrations.ts"];

/**
 * Files with BOTH kinds: a remote-controlled URL that must be guarded, and a
 * hardcoded first-party API that needn't be.
 *
 * `crosspost.ts` sends to graph.threads.net (fixed host, nothing to guard) but also
 * downloads the image and video-thumbnail URLs from a compose request — which is
 * where the two missed sites were. Every remaining bare fetch here must therefore be
 * provably first-party, checked against these patterns.
 */
const MIXED: Record<string, RegExp[]> = {
  "src/lib/crosspost.ts": [/graph\.threads\.net/],
};

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

/** Lines that call fetch() directly, ignoring comments and our own helpers. */
function bareFetchLines(src: string): string[] {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return false;
      if (!/\bfetch\s*\(/.test(t)) return false;
      // Our own wrappers, and same-origin browser calls.
      if (/guardedFetch|signedFetch|signedGet|guardedFetchJson|safeFetch/.test(t)) return false;
      if (/fetch\((["'`])\//.test(t)) return false;
      return true;
    })
    .map((l) => l.trim());
}

describe("no remote-controlled URL is fetched without the redirect guard", () => {
  it.each(REMOTE_URL_FETCHERS)("%s uses guardedFetch, never a bare fetch()", (rel) => {
    const src = read(rel);
    const bare = bareFetchLines(src);
    expect(bare, `${rel} still calls fetch() directly on a remote URL:\n${bare.join("\n")}`).toEqual([]);
  });

  it("safe-fetch.ts is the ONLY place that calls fetch() on such a URL", () => {
    // One implementation, so the rule can't drift back apart. `public-host.ts`
    // records the same lesson from #357: a rule only some paths enforce is worse
    // than no rule, because the unguarded path is the one people hit.
    const bare = bareFetchLines(read("src/lib/safe-fetch.ts"));
    expect(bare).toHaveLength(1);
    expect(bare[0]).toContain("fetch(current");
  });

  it("every guardedFetch call states a cross-origin policy explicitly", () => {
    // Not defaulted, on purpose: a write that follows a cross-host redirect is the
    // difference between a bug and a signed request aimed wherever a peer likes.
    // Checked per call site rather than by counting, so a doc comment mentioning
    // `crossOrigin` can't paper over a call that omits it.
    for (const rel of REMOTE_URL_FETCHERS) {
      const lines = read(rel).split("\n");
      lines.forEach((line, i) => {
        if (!/\bguardedFetch\(/.test(line) || line.trim().startsWith("*")) return;
        const window = lines.slice(i, i + 8).join("\n");
        expect(window, `${rel}:${i + 1} calls guardedFetch with no crossOrigin`).toMatch(/crossOrigin:/);
      });
    }
  });

  it.each(Object.keys(MIXED))("%s guards its remote URLs and only its remote URLs", (rel) => {
    const src = read(rel);
    // The remote-controlled downloads go through the guard…
    expect(src).toContain("guardedFetch(");
    // …and whatever bare fetch remains targets a hardcoded first-party host, on the
    // same line or the next one (the URL is often the first argument on its own line).
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("*") || t.startsWith("//")) return;
      if (!/\bfetch\s*\(/.test(t)) return;
      if (/guardedFetch|signedFetch|signedGet|guardedFetchJson|safeFetch/.test(t)) return;
      const window = lines.slice(i, i + 3).join("\n");
      const ok = MIXED[rel].some((re) => re.test(window));
      expect(ok, `${rel}:${i + 1} bare fetch is not a known first-party host:\n${window}`).toBe(true);
    });
  });

  it("leaves first-party API calls alone", () => {
    // These target a hardcoded API base, so there is no attacker-chosen URL and
    // nothing to guard. Listed so the sweep above can't quietly grow to cover them.
    for (const rel of FIRST_PARTY_ONLY) {
      expect(read(rel)).not.toContain("guardedFetch");
    }
  });
});

describe("the signed paths keep their asymmetry", () => {
  it("delivery refuses cross-host redirects; reads allow them", () => {
    const src = read("src/lib/http-signatures.ts");
    // signedFetch (POST, delivery) — locked down.
    expect(src.replace(/\n/g, " ")).toMatch(/crossOrigin: false,[^}]*label: "signedFetch"/);
    // signedGet (GET, actor/key reads) — permitted, because actor URLs redirect.
    expect(src.replace(/\n/g, " ")).toMatch(/crossOrigin: true,[^}]*label: "signedGet"/);
  });
});

beforeEach(() => vi.restoreAllMocks());
