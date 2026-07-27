import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Instance-wide domain blocks.
 *
 * Blocking individuals works right up until the same server produces ten more
 * of them, which is the whole reason domain blocks exist. Two things have to
 * hold for one to be worth anything: it must cover **subdomains** (a server that
 * hands them out could otherwise sidestep the block forever), and it must never
 * be possible to block your own instance — that would drop your own federated
 * traffic with nothing to explain why everything stopped.
 */

const { findUnique, findFirst } = vi.hoisted(() => ({ findUnique: vi.fn(), findFirst: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { blockedActor: { findUnique }, blockedDomain: { findFirst } },
}));

import { isBlockedSender, normalizeDomain, domainChain, actorHost, uriHostname } from "@/lib/blocks";

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  findFirst.mockResolvedValue(null);
});

describe("normalizeDomain", () => {
  it("lowercases and strips a port", () => {
    expect(normalizeDomain("Spam.Example:8443")).toBe("spam.example");
  });

  it("accepts a pasted URL", () => {
    expect(normalizeDomain("https://spam.example/users/bob")).toBe("spam.example");
  });

  it("accepts a pasted @handle@domain", () => {
    // The likeliest thing someone has on the clipboard.
    expect(normalizeDomain("@bob@spam.example")).toBe("spam.example");
  });

  it("strips a trailing dot (same host, different string)", () => {
    expect(normalizeDomain("spam.example.")).toBe("spam.example");
  });

  it("returns '' for junk", () => {
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain("   ")).toBe("");
  });
});

describe("domainChain — what a block on a host covers", () => {
  it("includes the host and its parents", () => {
    expect(domainChain("a.b.spam.example")).toContain("a.b.spam.example");
    expect(domainChain("a.b.spam.example")).toContain("spam.example");
  });

  it("never reduces to a bare TLD", () => {
    // Otherwise a block on "example.com" would be tested as "com" and could
    // match every .com instance in existence.
    expect(domainChain("evil.example.com")).not.toContain("com");
    expect(domainChain("example.com")).toEqual(["example.com"]);
  });
});

describe("isBlockedSender covers whole servers", () => {
  const ACTOR = "https://sub.spam.example/users/bob";

  it("drops an actor whose domain is blocked", async () => {
    findFirst.mockResolvedValue({ id: "d1" });
    expect(await isBlockedSender(ACTOR)).toBe(true);
  });

  it("checks the host and every parent domain", async () => {
    await isBlockedSender(ACTOR);
    const arg = findFirst.mock.calls[0][0];
    expect(arg.where.domain.in).toContain("sub.spam.example");
    expect(arg.where.domain.in).toContain("spam.example");
  });

  it("still drops an individually blocked actor on an unblocked server", async () => {
    findUnique.mockResolvedValue({ id: "a1" });
    expect(await isBlockedSender("https://mastodon.social/users/ada")).toBe(true);
  });

  it("lets an unrelated server through", async () => {
    expect(await isBlockedSender("https://mastodon.social/users/ada")).toBe(false);
  });

  it("fails open when the database errors", async () => {
    // An inbox that refuses everything because Postgres hiccuped is a worse
    // failure than briefly honouring one activity from a blocked sender.
    findFirst.mockRejectedValue(new Error("db down"));
    expect(await isBlockedSender(ACTOR)).toBe(false);
  });

  it("doesn't fall over on an unparseable actor URI", async () => {
    expect(await isBlockedSender("not a url")).toBe(false);
  });
});

describe("actorHost", () => {
  it("returns the lowercased host", () => {
    expect(actorHost("https://Spam.Example/users/b")).toBe("spam.example");
  });

  it("returns null for junk", () => {
    expect(actorHost("nonsense")).toBeNull();
  });
});

describe("ports do not defeat a domain block (#379)", () => {
  it("strips the port when deriving the host", () => {
    // Regression: uriHostname used .host, so "spam.example:8443" was tested
    // against port-less BlockedDomain rows and never matched. An actor served on
    // a non-default port was not domain-blocked at all — inbound OR outbound.
    expect(uriHostname("https://spam.example:8443/users/x")).toBe("spam.example");
  });

  it("blocks an inbound activity from an actor on a non-default port", async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockImplementation(async (a: { where: { domain: { in: string[] } } }) =>
      a.where.domain.in.includes("spam.example") ? { id: "d1" } : null);
    expect(await isBlockedSender("https://spam.example:8443/users/x")).toBe(true);
  });
});
