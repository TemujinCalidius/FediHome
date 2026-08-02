import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Leaving FediHome — `movedTo` plus an outbound `Move` (#347).
 *
 * The handshake is two-sided and BOTH ends must agree: the new account lists
 * this one in `alsoKnownAs`, and this one publishes `movedTo` plus a `Move`.
 * Every receiving server checks the first before honouring the second.
 *
 * That makes the pre-flight check the most important thing here. Sending a
 * `Move` the destination hasn't agreed to is NOT a harmless no-op — every server
 * refuses it, the followers stay put, the owner is told nothing, and they find
 * out months later when the old instance is already gone. By then no action
 * recovers them. So the failure has to happen HERE, loudly, before anything is
 * sent.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

const SELF = "https://demo.example/ap/actor";
const NEW = "https://new.example/users/ada";

interface Harness {
  rows: Record<string, string>;
  actorDoc: Record<string, unknown> | null;
  publicHost: boolean;
  fetchOk: boolean;
}

async function load(over: Partial<Harness> = {}) {
  const h: Harness = {
    rows: {},
    actorDoc: {
      preferredUsername: "ada",
      inbox: "https://new.example/inbox",
      alsoKnownAs: [SELF],
    },
    publicHost: true,
    fetchOk: true,
    ...over,
  };

  const upsert = vi.fn().mockResolvedValue({});
  const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
  const findUnique = vi.fn(async (args: { where: { key: string } }) =>
    args.where.key in h.rows ? { key: args.where.key, value: h.rows[args.where.key] } : null,
  );
  const findMany = vi.fn(async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => k in h.rows).map((k) => ({ key: k, value: h.rows[k] })),
  );
  const signedGet = vi.fn().mockResolvedValue({
    ok: h.fetchOk,
    json: async () => h.actorDoc,
  });
  const deliverToFollowers = vi.fn().mockResolvedValue(undefined);
  const assertPublicHost = vi.fn().mockResolvedValue(h.publicHost);

  vi.doMock("@/lib/db", () => ({
    prisma: { siteSetting: { findUnique, findMany, upsert, deleteMany } },
  }));
  vi.doMock("@/lib/http-signatures", () => ({ signedGet, deliverToFollowers }));
  vi.doMock("@/lib/url-guard", () => ({ assertPublicHost }));
  vi.doMock("@/lib/identity", () => ({
    getSiteUrl: () => "https://demo.example",
    getIdentity: () => ({ fediHandle: "ada", fediDomain: "demo.example" }),
  }));

  const mod = await import("@/lib/account-move");
  return { mod, upsert, deleteMany, deliverToFollowers, signedGet, assertPublicHost, h };
}

beforeEach(() => vi.resetModules());

describe("sameActor", () => {
  it("ignores trailing slashes, the way a remote server does", async () => {
    const { mod } = await load();
    expect(mod.sameActor("https://a.example/u/x", "https://a.example/u/x/")).toBe(true);
    expect(mod.sameActor("https://a.example/u/x", "https://a.example/u/y")).toBe(false);
  });

  it("strips a long run of slashes without backtracking", async () => {
    // These strings come out of a REMOTE actor document. `/\/+$/` backtracks
    // quadratically on a long run followed by anything else — CodeQL's
    // js/polynomial-redos, and the reason the inbox uses a character scan. The
    // implementation moved here, so the property has to move with it.
    const { mod } = await load();
    const nasty = "https://a.example/u/x" + "/".repeat(100_000);
    const t0 = process.hrtime.bigint();
    expect(mod.stripTrailingSlashes(nasty)).toBe("https://a.example/u/x");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(100);
  });
});

describe("verifyMoveTarget — the check every receiving server will make", () => {
  it("refuses a destination that doesn't list us as an alias", async () => {
    // THE case. Without it the owner sends a Move that every server refuses,
    // is told it worked, and loses their followers silently.
    const { mod, deliverToFollowers } = await load({
      actorDoc: { preferredUsername: "ada", inbox: "https://new.example/inbox", alsoKnownAs: [] },
    });
    const r = await mod.verifyMoveTarget(NEW);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/alias/i);
    expect(deliverToFollowers).not.toHaveBeenCalled();
  });

  it("accepts a destination that does, however it spells the alias", async () => {
    const { mod } = await load({
      actorDoc: {
        preferredUsername: "ada",
        inbox: "https://new.example/inbox",
        alsoKnownAs: `${SELF}/`, // bare string, trailing slash
      },
    });
    expect((await mod.verifyMoveTarget(NEW)).ok).toBe(true);
  });

  it("refuses this account itself", async () => {
    const { mod } = await load();
    const r = await mod.verifyMoveTarget(SELF);
    expect(r.ok).toBe(false);
  });

  it("refuses a destination that isn't a URL, without going near the network", async () => {
    const { mod, signedGet } = await load();
    for (const bad of ["", "   ", "@ada@new.example", "not a url"]) {
      expect((await mod.verifyMoveTarget(bad)).ok, bad).toBe(false);
    }
    expect(signedGet).not.toHaveBeenCalled();
  });

  it("refuses a destination inside our own network", async () => {
    // assertPublicHost runs before the fetch, so a hostile or careless address
    // can't turn the pre-flight check into an SSRF probe.
    const { mod, signedGet } = await load({ publicHost: false });
    expect((await mod.verifyMoveTarget("http://169.254.169.254/actor")).ok).toBe(false);
    expect(signedGet).not.toHaveBeenCalled();
  });

  it("refuses an unreachable destination rather than assuming the best", async () => {
    const { mod } = await load({ fetchOk: false });
    const r = await mod.verifyMoveTarget(NEW);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/reachable|Couldn't read/i);
  });

  it("uses a SIGNED fetch, or secure-mode servers can never be moved to", async () => {
    // An instance running authorized fetch answers an unsigned actor request
    // with 401. Verifying with a plain GET would refuse every move to one.
    const { mod, signedGet } = await load();
    await mod.verifyMoveTarget(NEW);
    expect(signedGet).toHaveBeenCalledWith(NEW, expect.any(Number));
  });
});

describe("startMove", () => {
  it("writes movedTo BEFORE delivering, not after", async () => {
    // A receiving server fetches this actor to verify. If the Move arrives
    // before the row is written it reads an account that hasn't moved and
    // refuses — and that follower is not recoverable.
    const order: string[] = [];
    const { mod, upsert, deliverToFollowers } = await load();
    upsert.mockImplementation(async () => { order.push("write"); });
    deliverToFollowers.mockImplementation(async () => { order.push("deliver"); });
    await mod.startMove(NEW);
    expect(order[0]).toBe("write");
    expect(order[order.length - 1]).toBe("deliver");
  });

  it("sends a Move addressed to our followers, with both actor and object set", async () => {
    const { mod, deliverToFollowers } = await load();
    await mod.startMove(NEW);
    const activity = deliverToFollowers.mock.calls[0][0];
    expect(activity).toMatchObject({
      type: "Move",
      actor: SELF,
      object: SELF, // Mastodon reads `object` on some paths and `actor` on others
      target: NEW,
      to: ["https://demo.example/ap/followers"],
    });
    expect(String(activity.id)).toMatch(/^https:\/\/demo\.example\/ap\/move\//);
  });

  it("delivers nothing at all when the destination doesn't agree", async () => {
    const { mod, upsert, deliverToFollowers } = await load({
      actorDoc: { preferredUsername: "ada", inbox: "https://new.example/inbox" },
    });
    const r = await mod.startMove(NEW);
    expect(r.ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
    expect(deliverToFollowers).not.toHaveBeenCalled();
  });

  it("reuses the activity id when re-declaring the SAME destination", async () => {
    // The retry queue is keyed @@unique([activityId, inbox]). A regenerated id
    // makes every retry a fresh activity the queue can't dedupe and remote
    // servers process again from scratch.
    const { mod, deliverToFollowers } = await load({
      rows: {
        "identity.movedTo": NEW,
        "identity.movedAt": "2026-08-01T00:00:00.000Z",
        "identity.moveActivityId": "https://demo.example/ap/move/111",
      },
    });
    await mod.startMove(NEW, new Date("2026-08-02T00:00:00.000Z"));
    expect(deliverToFollowers.mock.calls[0][0].id).toBe("https://demo.example/ap/move/111");
  });

  it("refuses a DIFFERENT destination inside the cooldown, and says how long", async () => {
    const { mod, deliverToFollowers } = await load({
      rows: {
        "identity.movedTo": "https://first.example/users/ada",
        "identity.movedAt": "2026-08-01T00:00:00.000Z",
        "identity.moveActivityId": "https://demo.example/ap/move/111",
      },
    });
    const r = await mod.startMove(NEW, new Date("2026-08-05T00:00:00.000Z"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/26 more day/);
    expect(deliverToFollowers).not.toHaveBeenCalled();
  });

  it("allows a different destination once the cooldown has passed", async () => {
    const { mod, deliverToFollowers } = await load({
      rows: {
        "identity.movedTo": "https://first.example/users/ada",
        "identity.movedAt": "2026-06-01T00:00:00.000Z",
        "identity.moveActivityId": "https://demo.example/ap/move/111",
      },
    });
    const r = await mod.startMove(NEW, new Date("2026-08-05T00:00:00.000Z"));
    expect(r.ok).toBe(true);
    // A new destination is a NEW activity — servers must not treat it as a
    // redelivery of the move to somewhere else.
    expect(deliverToFollowers.mock.calls[0][0].id).not.toBe("https://demo.example/ap/move/111");
  });
});

describe("resend and cancel", () => {
  it("re-sends the identical activity, so servers that acted already ignore it", async () => {
    const { mod, deliverToFollowers } = await load({
      rows: {
        "identity.movedTo": NEW,
        "identity.movedAt": "2026-08-01T00:00:00.000Z",
        "identity.moveActivityId": "https://demo.example/ap/move/111",
      },
    });
    const r = await mod.resendMove();
    expect(r.ok).toBe(true);
    expect(deliverToFollowers.mock.calls[0][0]).toMatchObject({
      id: "https://demo.example/ap/move/111",
      type: "Move",
      target: NEW,
    });
  });

  it("has nothing to re-send when the account hasn't moved", async () => {
    const { mod, deliverToFollowers } = await load();
    expect((await mod.resendMove()).ok).toBe(false);
    expect(deliverToFollowers).not.toHaveBeenCalled();
  });

  it("cancelling clears all three rows and sends nothing", async () => {
    // Cancelling is local. It stops TELLING people you moved; it cannot reach
    // into a server that already re-pointed its follow.
    const { mod, deleteMany, deliverToFollowers } = await load({
      rows: { "identity.movedTo": NEW },
    });
    await mod.cancelMove();
    expect(deleteMany.mock.calls[0][0].where.key.in).toEqual([
      "identity.movedTo", "identity.movedAt", "identity.moveActivityId",
    ]);
    expect(deliverToFollowers).not.toHaveBeenCalled();
  });
});

describe("getMoveState / hasMoved", () => {
  it("reports not-moved on a normal instance", async () => {
    const { mod } = await load();
    expect(await mod.hasMoved()).toBe(false);
    expect((await mod.getMoveState()).movedTo).toBeNull();
  });

  it("counts the cooldown down from the move date", async () => {
    const { mod } = await load({
      rows: { "identity.movedTo": NEW, "identity.movedAt": "2026-08-01T00:00:00.000Z" },
    });
    const s = await mod.getMoveState(new Date("2026-08-11T00:00:00.000Z"));
    expect(s.cooldownDaysLeft).toBe(20);
    expect((await mod.getMoveState(new Date("2026-10-01T00:00:00.000Z"))).cooldownDaysLeft).toBe(0);
  });

  it("does not un-move the account when the database is unreadable", async () => {
    // An actor document that drops movedTo tells every remote server the move
    // was reverted. getMovedTo returning null on error is the lesser evil only
    // because throwing would 500 the actor document entirely — so it must at
    // least not be reached by a *successful* read of an empty value.
    const { mod } = await load({ rows: { "identity.movedTo": "   " } });
    expect(await mod.getMovedTo()).toBeNull();
  });
});

/**
 * Publishing is what stops after a move. Replies, likes and boosts deliberately
 * do not: those are interactions with conversations already in flight, and
 * cutting them off mid-thread strands other people rather than protecting
 * anyone. Enumerated as a source scan for the same reason the SSRF sweep is —
 * a rule only some entry points enforce is worse than no rule, because the
 * unguarded one is the one someone's blog editor is pointed at.
 */
describe("#347 — every publish entry point refuses after a move", () => {
  const PUBLISH_ENTRY_POINTS = [
    "src/app/api/compose/route.ts",
    "src/app/api/micropub/route.ts",
    "src/app/xmlrpc/route.ts",
    "src/lib/publish-post.ts",
  ];

  it.each(PUBLISH_ENTRY_POINTS)("%s checks hasMoved()", (rel) => {
    expect(read(rel)).toMatch(/hasMoved\(\)/);
  });

  it("the scheduler leaves due posts SCHEDULED rather than consuming them", () => {
    // Nothing is claimed, so cancelling the move releases them and moving for
    // good means they were never silently marked published-and-undelivered.
    const src = read("src/lib/publish-post.ts");
    const guard = src.slice(src.indexOf("export async function publishDueScheduledPosts"));
    const check = guard.indexOf("hasMoved()");
    const firstClaim = guard.indexOf("prisma.post.updateMany");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(firstClaim);
  });

  it("interactions are NOT gated — the asymmetry is deliberate", () => {
    for (const rel of [
      "src/app/api/admin/_actions/replies.ts",
      "src/app/api/admin/_actions/fedi-interactions.ts",
    ]) {
      expect(read(rel)).not.toMatch(/hasMoved/);
    }
  });
});

describe("#347 — the actor document", () => {
  it("defines movedTo as a JSON-LD term, because AS2 core does not", () => {
    // Verified by fetching the published AS2 context: alsoKnownAs, Move and
    // target ARE defined there; movedTo and manuallyApprovesFollowers are NOT.
    // A strict consumer drops an undefined term — which for movedTo means the
    // move is invisible to exactly the servers most careful about reading it.
    const src = read("src/lib/federation.ts");
    expect(src).toContain('movedTo: { "@id": "as:movedTo", "@type": "@id" }');
    expect(src).toContain('manuallyApprovesFollowers: "as:manuallyApprovesFollowers"');
  });

  it("emits movedTo only once set, so a normal actor is unchanged", () => {
    const src = read("src/lib/federation.ts");
    expect(src).toContain("...(movedTo ? { movedTo } : {})");
  });
});

describe("#347 — the admin route", () => {
  it("is cookie-only; no app token may redirect the owner's followers", () => {
    // The second half of an account takeover. `verifyAdmin`, not
    // `authenticateApiRequest`, exactly as the aliases and identity routes are.
    const src = read("src/app/api/admin/move/route.ts");
    expect(src).toContain("verifyAdmin");
    expect(src).not.toContain("authenticateApiRequest");
    expect(src).toContain("verifyOrigin");
  });

  it("awaits verifyAdmin everywhere — a missing await silently bypasses auth", () => {
    // #14: verifyAdmin is async, so `if (!verifyAdmin(req))` is always false and
    // tsc will not catch it.
    const src = read("src/app/api/admin/move/route.ts");
    for (const m of src.matchAll(/verifyAdmin\(/g)) {
      expect(src.slice(Math.max(0, m.index - 12), m.index)).toContain("await");
    }
  });
});
