import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading remote actor documents (#591).
 *
 * Every actor fetch in this tree does `const actor = await res.json()` and hands
 * the result downstream as if it matched `ResolvedFediActor`. It is `any`, it
 * came from somebody else's server, and AS2 permits more shapes than the code
 * allowed for.
 *
 * **The fixtures are why this survived.** Mastodon, Lemmy and Pixelfed all send
 * a single `icon` object, so every actor fixture in this repo encodes that shape
 * — and twelve copies of `actor.icon?.url || null` read correctly against all of
 * them. PeerTube sends an array, `.url` on an array is `undefined`, and the
 * avatar became `null` with nothing thrown and nothing logged. `next.config.ts`
 * ships ten PeerTube hosts, so this is not a hypothetical shape.
 */

const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ guardedFetch }));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { actorImageUrl, actorInboxUrl } from "@/lib/actor-shapes";
import { resolveFediActorByUri } from "@/lib/fedi-resolve";

const AVATAR = "https://peertube.example/lazy-static/avatars/abc.jpg";

describe("actorImageUrl — every shape AS2 allows", () => {
  it("reads the single-object form", () => {
    // Mastodon, Lemmy, Pixelfed. The only shape the old code handled.
    expect(actorImageUrl({ type: "Image", url: AVATAR })).toBe(AVATAR);
  });

  it("reads the ARRAY form — the bug (#591)", () => {
    // PeerTube advertises several sizes with the small one hoisted first.
    expect(
      actorImageUrl([
        { type: "Image", width: 48, url: AVATAR },
        { type: "Image", width: 600, url: "https://peertube.example/big.jpg" },
      ]),
    ).toBe(AVATAR);
  });

  it("reads a bare URL string", () => {
    expect(actorImageUrl(AVATAR)).toBe(AVATAR);
  });

  it("reads an Image whose url is a Link object", () => {
    expect(actorImageUrl({ type: "Image", url: { type: "Link", href: AVATAR } })).toBe(AVATAR);
  });

  it("reads a Link standing in for the Image", () => {
    expect(actorImageUrl({ type: "Link", href: AVATAR })).toBe(AVATAR);
  });

  it("skips unusable entries and takes the first that works", () => {
    expect(actorImageUrl([{ type: "Image" }, null, { url: AVATAR }])).toBe(AVATAR);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty array", []],
    ["an object with no url", { type: "Image" }],
    ["a number", 42],
  ])("returns null for %s", (_label, value) => {
    expect(actorImageUrl(value)).toBeNull();
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:image/svg+xml;base64,PHN2Zz4="],
    ["not a url at all", "not a url"],
  ])("refuses %s — these are stored and later rendered as image sources", (_l, value) => {
    expect(actorImageUrl(value)).toBeNull();
  });
});

describe("actorInboxUrl — a type check, not truthiness", () => {
  it("accepts a single URL string", () => {
    expect(actorInboxUrl("https://a.example/inbox")).toBe("https://a.example/inbox");
  });

  it("REFUSES an array rather than picking one", () => {
    // `String()` further down turns this into "https://a/inbox,https://b/inbox",
    // which parses, with host `a`. Choosing which server receives someone's
    // private mention is not a guess worth making.
    expect(actorInboxUrl(["https://a.example/inbox", "https://b.example/inbox"])).toBeNull();
  });

  it.each([
    ["a number", 123],
    ["an object", { href: "https://a.example/inbox" }],
    ["undefined", undefined],
    ["a non-http scheme", "file:///etc/passwd"],
  ])("refuses %s", (_label, value) => {
    expect(actorInboxUrl(value)).toBeNull();
  });
});

/** A remote actor document, served as-is. */
const serveActor = (actor: unknown) =>
  guardedFetch.mockResolvedValue({ ok: true, json: async () => actor });

const PEERTUBE_ACTOR = {
  preferredUsername: "channel",
  name: "A Channel",
  inbox: "https://peertube.example/inbox",
  icon: [
    { type: "Image", width: 48, url: AVATAR },
    { type: "Image", width: 600, url: "https://peertube.example/big.jpg" },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe("resolveFediActorByUri — end to end", () => {
  it("keeps the avatar of a PeerTube actor", async () => {
    // The whole issue in one assertion. Against the old read this was null, and
    // the row was written that way — permanently, with nothing logged.
    serveActor(PEERTUBE_ACTOR);
    const actor = await resolveFediActorByUri("https://peertube.example/accounts/channel");
    expect(actor?.avatarUrl).toBe(AVATAR);
  });

  it("still keeps the avatar of a Mastodon-shaped actor", async () => {
    serveActor({ ...PEERTUBE_ACTOR, icon: { type: "Image", url: AVATAR } });
    const actor = await resolveFediActorByUri("https://mastodon.example/users/ada");
    expect(actor?.avatarUrl).toBe(AVATAR);
  });

  it("refuses an actor whose inbox is an array", async () => {
    serveActor({ ...PEERTUBE_ACTOR, inbox: ["https://a.example/inbox", "https://b.example/inbox"] });
    expect(await resolveFediActorByUri("https://x.example/users/eve")).toBeNull();
  });

  it("refuses an actor with no inbox at all", async () => {
    const { inbox: _drop, ...noInbox } = PEERTUBE_ACTOR;
    serveActor(noInbox);
    expect(await resolveFediActorByUri("https://x.example/users/eve")).toBeNull();
  });
});

/**
 * No thirteenth copy (#591).
 *
 * There were twelve, and they were identical, and every one of them read
 * correctly against every fixture in the repo. A structural assertion is the
 * only thing that would have caught the twelfth — and it is what catches the
 * next actor fetch somebody writes.
 *
 * Same idiom as `bluesky-agent-call-sites.test.ts` and `block-read-paths.test.ts`.
 */
describe("#591 — nothing reads an actor image by hand", () => {
  const ROOT = process.cwd();
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

  /** Every .ts/.tsx under src/ and scripts/, excluding tests and generated code. */
  const sourceFiles = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(ROOT, rel)).isDirectory()) {
        if (entry === "__tests__" || entry === "generated" || entry === "node_modules") continue;
        sourceFiles(rel, out);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(rel);
      }
    }
    return out;
  };

  it("no file picks `.url` off an icon or image itself", () => {
    const offenders = [...sourceFiles("src"), ...sourceFiles("scripts")].filter(
      (f) => f !== "src/lib/actor-shapes.ts" && /\b(icon|image)\??\.url\b/.test(read(f)),
    );
    expect(
      offenders,
      "these read an AS2 icon/image by hand, which misses the array form PeerTube sends — " +
        "use actorImageUrl() from @/lib/actor-shapes",
    ).toEqual([]);
  });

  it("the three repair scripts use the shared reader", () => {
    // NOT optional collateral: fix-follows.ts is the avatar-repair tool, and its
    // own header says it re-fetches actor info for records missing avatars. Fix
    // the library and leave the script, and the next repair run writes NULL
    // over exactly the rows the fix was meant to populate.
    for (const rel of [
      "scripts/fix-follows.ts",
      "scripts/fix-follows-signed.ts",
      "scripts/backfill-posts.ts",
    ]) {
      expect(read(rel), `${rel} stopped using actorImageUrl`).toMatch(/actorImageUrl\(/);
    }
  });
});
