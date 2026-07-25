import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Inbound `Move` — following someone across a server migration (#339).
 *
 * Before this, a `Move` fell through to `default:` and was dropped. Your follow
 * stayed pointed at the abandoned account, their posts stopped arriving, and
 * nothing anywhere said why.
 *
 * The verification is the whole point, and it's a security property, not a
 * nicety. The HTTP signature proves the OLD account sent the Move. It does NOT
 * prove the NEW account agrees. Without checking that the target's
 * `alsoKnownAs` names the origin, `Move` is an account-hijack primitive: anyone
 * could redirect a follow they don't own to an account they control.
 */

const { verifyIncomingSignature, actorMatchesSigner, deliverActivity, signedGet, processAttachments, fetchLinkEmbed, sendPushToOwner, assertPublicHost } =
  vi.hoisted(() => ({
    verifyIncomingSignature: vi.fn(),
    actorMatchesSigner: vi.fn(),
    deliverActivity: vi.fn(),
    signedGet: vi.fn(),
    processAttachments: vi.fn(),
    fetchLinkEmbed: vi.fn(),
    sendPushToOwner: vi.fn(),
    assertPublicHost: vi.fn(),
  }));
vi.mock("@/lib/http-signatures", () => ({ verifyIncomingSignature, actorMatchesSigner, deliverActivity, signedGet }));
vi.mock("@/lib/fedi-media", () => ({ processAttachments, fetchLinkEmbed }));
vi.mock("@/lib/push", () => ({ sendPushToOwner }));
vi.mock("@/lib/notifications", () => ({ resolveOwnedTarget: vi.fn() }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost }));
vi.mock("@/lib/db", () => ({
  prisma: {
    blockedActor: { findUnique: vi.fn() },
    fediFollowing: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    fediFollower: { findUnique: vi.fn(), findMany: vi.fn() },
    fediPost: { findUnique: vi.fn(), upsert: vi.fn(), findFirst: vi.fn() },
    fediInteraction: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

import { POST } from "@/app/ap/inbox/route";
import { prisma } from "@/lib/db";

const OLD_ACTOR = "https://old.example/users/ada";
const NEW_ACTOR = "https://new.example/users/ada";
const IMPOSTOR = "https://evil.example/users/mallory";

const move = (over: Record<string, unknown> = {}) => ({
  type: "Move",
  actor: OLD_ACTOR,
  object: OLD_ACTOR,
  target: NEW_ACTOR,
  ...over,
});

const req = (activity: Record<string, unknown>): NextRequest =>
  new Request("https://demo.example/ap/inbox", {
    method: "POST",
    headers: { "content-type": "application/activity+json" },
    body: JSON.stringify(activity),
  }) as unknown as NextRequest;

/** The target actor document, with whatever aliases the test wants. */
const targetDoc = (alsoKnownAs: unknown) =>
  new Response(
    JSON.stringify({
      id: NEW_ACTOR,
      preferredUsername: "ada",
      name: "Ada",
      inbox: "https://new.example/users/ada/inbox",
      ...(alsoKnownAs === undefined ? {} : { alsoKnownAs }),
    }),
    { status: 200 },
  );

beforeEach(() => {
  vi.clearAllMocks();
  verifyIncomingSignature.mockImplementation(async (_r: unknown, raw: string) => ({
    valid: true,
    actorUri: (JSON.parse(raw) as { actor: string }).actor,
  }));
  actorMatchesSigner.mockReturnValue(true);
  assertPublicHost.mockResolvedValue(true);
  deliverActivity.mockResolvedValue({ ok: true, status: 202 });
  sendPushToOwner.mockResolvedValue(undefined);
  vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue(null as never);
  // We follow the old account.
  vi.mocked(prisma.fediFollowing.findUnique).mockResolvedValue({
    actorUri: OLD_ACTOR,
    inbox: "https://old.example/users/ada/inbox",
    username: "ada",
    domain: "old.example",
    displayName: "Ada",
  } as never);
  vi.mocked(prisma.fediFollowing.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.fediFollowing.delete).mockResolvedValue({} as never);
  signedGet.mockResolvedValue(targetDoc([OLD_ACTOR]));
});

describe("a verified Move re-points the follow", () => {
  it("follows the new account and stops following the old one", async () => {
    const res = await POST(req(move()));
    expect(res.status).toBe(202);

    expect(prisma.fediFollowing.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { actorUri: NEW_ACTOR },
        create: expect.objectContaining({ actorUri: NEW_ACTOR, domain: "new.example" }),
      }),
    );
    expect(prisma.fediFollowing.delete).toHaveBeenCalledWith({ where: { actorUri: OLD_ACTOR } });

    const sent = deliverActivity.mock.calls.map((c) => c[1] as { type: string; object: unknown });
    expect(sent.some((a) => a.type === "Follow" && a.object === NEW_ACTOR)).toBe(true);
    expect(sent.some((a) => a.type === "Undo")).toBe(true);
  });

  it("tells the owner their follow moved", async () => {
    await POST(req(move()));
    expect(sendPushToOwner).toHaveBeenCalledWith(
      expect.objectContaining({ type: "move" }),
    );
  });

  it("fetches the target actor with a SIGNED request", async () => {
    // An authorized-fetch instance answers unsigned actor requests with 401, so
    // an unsigned fetch would silently refuse every move from such a server.
    await POST(req(move()));
    expect(signedGet).toHaveBeenCalledWith(NEW_ACTOR, expect.any(Number));
  });

  it("accepts alsoKnownAs given as a bare string rather than an array", async () => {
    signedGet.mockResolvedValue(targetDoc(OLD_ACTOR));
    await POST(req(move()));
    expect(prisma.fediFollowing.upsert).toHaveBeenCalled();
  });

  it("tolerates a trailing slash on the alias", async () => {
    // An actor id differing by a slash is a different id — but this comparison
    // is ours to make forgiving, and a stray slash shouldn't break a real move.
    signedGet.mockResolvedValue(targetDoc([`${OLD_ACTOR}/`]));
    await POST(req(move()));
    expect(prisma.fediFollowing.upsert).toHaveBeenCalled();
  });
});

describe("an unverified Move is refused — this is the hijack guard", () => {
  it("refuses when the target does not list the origin in alsoKnownAs", async () => {
    signedGet.mockResolvedValue(targetDoc([]));
    const res = await POST(req(move()));
    expect(res.status).toBe(202); // still 202 — we just don't act
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
    expect(prisma.fediFollowing.delete).not.toHaveBeenCalled();
    expect(deliverActivity).not.toHaveBeenCalled();
  });

  it("refuses when the target claims a DIFFERENT account", async () => {
    signedGet.mockResolvedValue(targetDoc(["https://someone-else.example/users/x"]));
    await POST(req(move()));
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });

  it("refuses when alsoKnownAs is absent entirely", async () => {
    signedGet.mockResolvedValue(targetDoc(undefined));
    await POST(req(move()));
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });

  it("cannot be used to redirect a follow to an attacker's account", async () => {
    // Mallory controls evil.example and sends a Move for an account she doesn't
    // own. Her actor legitimately lists nothing, so verification fails.
    signedGet.mockResolvedValue(
      new Response(
        JSON.stringify({ id: IMPOSTOR, preferredUsername: "mallory", inbox: `${IMPOSTOR}/inbox` }),
        { status: 200 },
      ),
    );
    await POST(req(move({ target: IMPOSTOR })));
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
    expect(prisma.fediFollowing.delete).not.toHaveBeenCalled();
  });

  it("refuses a target on a private host", async () => {
    assertPublicHost.mockResolvedValue(false);
    await POST(req(move({ target: "https://169.254.169.254/users/x" })));
    expect(signedGet).not.toHaveBeenCalled();
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });

  it("ignores a target actor with no inbox", async () => {
    signedGet.mockResolvedValue(
      new Response(JSON.stringify({ id: NEW_ACTOR, alsoKnownAs: [OLD_ACTOR] }), { status: 200 }),
    );
    await POST(req(move()));
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });
});

describe("Moves we should simply ignore", () => {
  it("ignores a Move from an account we don't follow", async () => {
    vi.mocked(prisma.fediFollowing.findUnique).mockResolvedValue(null as never);
    await POST(req(move()));
    expect(signedGet).not.toHaveBeenCalled(); // no wasted fetch
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });

  it("is idempotent on redelivery", async () => {
    // After a successful move the origin row is gone, so a repeat finds nothing.
    vi.mocked(prisma.fediFollowing.findUnique).mockResolvedValue(null as never);
    const res = await POST(req(move()));
    expect(res.status).toBe(202);
    expect(prisma.fediFollowing.delete).not.toHaveBeenCalled();
  });

  it("ignores a Move with no target", async () => {
    await POST(req(move({ target: undefined })));
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });

  it("ignores a Move pointing at itself", async () => {
    await POST(req(move({ target: OLD_ACTOR })));
    expect(prisma.fediFollowing.upsert).not.toHaveBeenCalled();
  });

  it("drops a Move from a blocked actor before any of this runs", async () => {
    vi.mocked(prisma.blockedActor.findUnique).mockResolvedValue({ id: "b1" } as never);
    await POST(req(move()));
    expect(prisma.fediFollowing.findUnique).not.toHaveBeenCalled();
    expect(signedGet).not.toHaveBeenCalled();
  });
});

describe("hostile input can't stall the inbox (js/polynomial-redos)", () => {
  it("handles an alias made of a huge run of slashes in constant-ish time", async () => {
    // The trailing-slash comparison used to be /\/+$/, which backtracks
    // quadratically on slashes-followed-by-anything. These strings come out of a
    // REMOTE actor document, so this is a value an attacker fully controls.
    const nasty = `${"/".repeat(120_000)}a`;
    signedGet.mockResolvedValue(targetDoc([nasty, OLD_ACTOR]));

    const started = performance.now();
    const res = await POST(req(move()));
    const elapsed = performance.now() - started;

    expect(res.status).toBe(202);
    // The quadratic version takes seconds on input this size; the scan is O(n).
    expect(elapsed).toBeLessThan(2000);
    // ...and the legitimate alias in the same list still verifies.
    expect(prisma.fediFollowing.upsert).toHaveBeenCalled();
  });

  it("handles a slash-heavy actor URI on the activity itself", async () => {
    const nastyTarget = `https://new.example/users/${"/".repeat(120_000)}a`;
    signedGet.mockResolvedValue(targetDoc([OLD_ACTOR]));
    const started = performance.now();
    await POST(req(move({ target: nastyTarget })));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
