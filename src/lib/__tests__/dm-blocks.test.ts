import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #564 — the DM block filter, and the two things about it that are easy to get
 * subtly wrong.
 *
 * 1. THE POLYMORPHIC KEY. `DirectMessage.senderUri` holds an actorUri for the
 *    fediverse and a DID for Bluesky, and there is no `domain` column — the
 *    domain lives inside `senderHandle`, in two different formats. Handing the
 *    whole set to `blockedActorUris` looks right and half-works: a DID yields no
 *    host, so the domain query is skipped for every Bluesky row. That is #563's
 *    bug from the other direction.
 *
 * 2. THE `take: 200` CAP. Both display reads are capped, so the exclusion has to
 *    be in the query. Filtering the returned page would quietly hand back 199.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    directMessage: { findMany: vi.fn() },
    blockedActor: { findMany: vi.fn() },
    blockedDomain: { findMany: vi.fn() },
  },
}));

import { blockedDmSenders } from "@/lib/blocks";
import { prisma } from "@/lib/db";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

const FEDI = { senderUri: "https://spam.example/users/mallory", senderHandle: "@mallory@spam.example", source: "fedi" };
const BSKY = { senderUri: "did:plc:mallory", senderHandle: "alice.spam.example", source: "bluesky" };
const OK = { senderUri: "https://mastodon.example/users/ada", senderHandle: "@ada@mastodon.example", source: "fedi" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([] as never);
});

describe("blockedDmSenders — the polymorphic key", () => {
  it("catches a fediverse sender by exact actor", async () => {
    vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([{ actorUri: FEDI.senderUri }] as never);
    expect([...(await blockedDmSenders([FEDI, OK]))]).toEqual([FEDI.senderUri]);
  });

  it("catches a Bluesky sender by DID", async () => {
    vi.mocked(prisma.blockedActor.findMany).mockResolvedValue([{ actorUri: BSKY.senderUri }] as never);
    expect([...(await blockedDmSenders([BSKY]))]).toEqual([BSKY.senderUri]);
  });

  it("catches a fediverse sender by DOMAIN, including a subdomain", async () => {
    vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([{ domain: "spam.example" }] as never);
    expect([...(await blockedDmSenders([FEDI, OK]))]).toEqual([FEDI.senderUri]);
  });

  it("catches a BLUESKY sender by domain — the half a DID lookup would miss", async () => {
    // THE test. `hostCandidates("did:plc:…")` is [], so routing Bluesky rows
    // through the URI path would skip the domain query entirely and this would
    // come back empty while the block is plainly in force.
    vi.mocked(prisma.blockedDomain.findMany).mockResolvedValue([{ domain: "spam.example" }] as never);
    expect([...(await blockedDmSenders([BSKY]))]).toEqual([BSKY.senderUri]);
  });

  it("asks about the handle's domain for Bluesky, not the DID", async () => {
    await blockedDmSenders([BSKY]);
    const asked = vi.mocked(prisma.blockedDomain.findMany).mock.calls[0]?.[0]?.where as {
      domain?: { in?: string[] };
    };
    expect(asked?.domain?.in).toContain("spam.example");
    expect(asked?.domain?.in).not.toContain("did:plc:mallory");
  });

  it("leaves an unblocked sender alone", async () => {
    expect([...(await blockedDmSenders([FEDI, BSKY, OK]))]).toEqual([]);
  });

  it("fails CLOSED — a database error blocks everyone rather than nobody", async () => {
    // Opposite posture to blockedPostFilter, deliberately: an empty DM list on a
    // DB error is a far smaller harm than a blocked person's message arriving,
    // and the database is already down in that scenario.
    vi.mocked(prisma.blockedActor.findMany).mockRejectedValue(new Error("db down"));
    expect((await blockedDmSenders([FEDI, OK])).size).toBe(2);
  });

  it("asks nothing when there are no senders", async () => {
    expect((await blockedDmSenders([])).size).toBe(0);
    expect(prisma.blockedActor.findMany).not.toHaveBeenCalled();
  });
});

describe("#564 — every DM read surface applies it", () => {
  /**
   * Structural, and for the same reason `block-read-paths.test.ts` is: the
   * failure mode is one surface being forgotten, which no behavioural test of
   * the other four can see. The SSR/API pair matters most — #459 was exactly
   * that, where the first paint hid a blocked account and every refetch
   * brought it back.
   */
  it.each([
    ["src/app/api/dms/route.ts", "the API the app reads"],
    ["src/app/timeline/page.tsx", "the SSR first paint — must match the API"],
    ["src/lib/notifications.ts", "the bell AND the push badge count"],
    ["src/app/api/admin/_actions/dms.ts", "mark-all-read, which writes rows per conversation"],
  ])("%s filters DMs (%s)", (rel) => {
    expect(read(rel)).toContain("blockedDmSenderUris");
  });

  it("the exclusion is expressed in the query, so `take` stays honest", () => {
    // A post-fetch filter would return 199 of a 200-message page and lose the
    // 200th silently. Both capped reads must carry the NOT into the where.
    for (const rel of ["src/app/api/dms/route.ts", "src/app/timeline/page.tsx"]) {
      expect(read(rel), rel).toMatch(/NOT: \{ senderUri: \{ in: blockedDmUris \} \}/);
    }
  });

  it("the Bluesky poller refuses to store a blocked sender's message", () => {
    // The one unguarded WRITE — the fediverse inbox refuses at the door, this
    // did not. Both halves per #563, so a domain block applies.
    const src = read("src/lib/bluesky-dm-poll.ts");
    expect(src).toContain("isBlueskyBlocked");
    expect(src).toMatch(/handle: senderHandle/);
  });
});
