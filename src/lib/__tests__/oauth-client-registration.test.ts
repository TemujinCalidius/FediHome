import { describe, it, expect, vi, beforeEach } from "vitest";
import { isSafeRedirectScheme, validateRedirectUri, getClient } from "@/lib/oauth";

/**
 * #366. Only three hardcoded client ids could authenticate, so no third-party
 * app could sign in even with the owner's explicit consent.
 *
 * Registration is the half that IndieAuth provably cannot cover: Obsidian,
 * Raycast and local helpers redirect to a custom scheme, and nothing about a
 * scheme proves who owns it. The owner asserting it IS the security model.
 */
describe("redirect scheme allowlist — the sharpest edge in this change", () => {
  it("refuses javascript: and friends", () => {
    // authorize/route.ts renders the target as href="${escapeHtml(target)}" and
    // then calls location.replace(a.href). escapeHtml does nothing to a SCHEME,
    // so this is script execution in the owner's authenticated session.
    for (const u of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)".trim(),
      "data:text/html,<script>x</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "blob:https://x/y",
    ]) {
      expect(isSafeRedirectScheme(u), u).toBe(false);
    }
  });

  it("allows the schemes real clients use", () => {
    for (const u of ["obsidian://cb", "raycast://cb", "https://quill.p3k.io/auth", "http://127.0.0.1:1/cb"]) {
      expect(isSafeRedirectScheme(u), u).toBe(true);
    }
  });

  it("refuses a URI with no scheme at all", () => {
    for (const u of ["/callback", "example.com/cb", ""]) {
      expect(isSafeRedirectScheme(u), u).toBe(false);
    }
  });

  it("is enforced on the path EVERY client goes through", () => {
    // Not in the admin handler alone — a hand-edited database row has to fail
    // too. That is the #431 lesson: validate wherever the value comes from.
    const evil = {
      id: "x", label: "x", kind: "registered" as const,
      redirectSchemes: ["javascript:alert(1)"], allowLoopback: false, loopbackPath: "",
    };
    expect(validateRedirectUri(evil, "javascript:alert(1)")).toBe(false);
  });

  it("does not break the first-party clients", () => {
    const mac = getClient("fedihome-macos")!;
    expect(validateRedirectUri(mac, "fedihome-macos://callback")).toBe(true);
    expect(validateRedirectUri(mac, "http://127.0.0.1:9999/callback")).toBe(true);
  });
});

describe("resolveClient — first-party costs no query", () => {
  const findFirst = vi.fn();
  const load = async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ prisma: { oAuthClientRegistration: { findFirst } } }));
    const mod = await import("@/lib/oauth-clients");
    mod.resetClientCache();
    return mod;
  };
  beforeEach(() => {
    vi.resetModules();
    findFirst.mockReset().mockResolvedValue(null);
  });

  it("resolves a built-in app without touching the database", async () => {
    const { resolveClient } = await load();
    expect((await resolveClient("fedihome-ios"))?.kind).toBe("first-party");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("caches a MISS, so an unknown id is not a free database query", async () => {
    // GET /api/oauth/authorize has no rate limit, and that is safe today only
    // because an unknown client_id costs zero queries. A DB-backed resolver
    // would make every unknown id a query, pre-auth and unmetered, on an
    // endpoint layout.tsx advertises to the entire web.
    const { resolveClient } = await load();
    for (let i = 0; i < 5; i++) await resolveClient("unknown-app");
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed id before querying at all", async () => {
    const { resolveClient } = await load();
    expect(await resolveClient("a")).toBeNull();
    expect(await resolveClient("x".repeat(500))).toBeNull();
    expect(await resolveClient("has spaces")).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns a registered client", async () => {
    findFirst.mockResolvedValue({
      id: "row1", clientId: "obsidian-fedihome", label: "Obsidian",
      redirectUris: ["obsidian://fedihome"], createdAt: new Date(), lastUsedAt: null,
    });
    const { resolveClient } = await load();
    const c = await resolveClient("obsidian-fedihome");
    expect(c?.kind).toBe("registered");
    expect(c?.label).toBe("Obsidian");
  });

  it("gives a registered client NO loopback wildcard", async () => {
    // A first-party app's loopback path is fixed and known. A registered one
    // would be the owner asserting a whole port range, which is more than they
    // were asked to assert.
    findFirst.mockResolvedValue({
      id: "row1", clientId: "thing", label: "T",
      redirectUris: ["thing://cb"], createdAt: new Date(), lastUsedAt: null,
    });
    const { resolveClient } = await load();
    const c = (await resolveClient("thing"))!;
    expect(c.allowLoopback).toBe(false);
    expect(validateRedirectUri(c, "http://127.0.0.1:1234/cb")).toBe(false);
    expect(validateRedirectUri(c, "thing://cb")).toBe(true);
  });

  it("authorises nothing when the database is down", async () => {
    findFirst.mockRejectedValue(new Error("down"));
    const { resolveClient } = await load();
    expect(await resolveClient("thing")).toBeNull();
  });
});

describe("registerClient", () => {
  const findFirst = vi.fn();
  const create = vi.fn();
  const load = async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ prisma: { oAuthClientRegistration: { findFirst, create } } }));
    const mod = await import("@/lib/oauth-clients");
    mod.resetClientCache();
    return mod;
  };
  beforeEach(() => {
    vi.resetModules();
    findFirst.mockReset().mockResolvedValue(null);
    create.mockReset().mockResolvedValue({});
  });

  it("registers a client with a custom scheme", async () => {
    const { registerClient } = await load();
    expect(await registerClient("obsidian-fedihome", "Obsidian", ["obsidian://fedihome"])).toEqual({ ok: true });
  });

  it("refuses a redirect URI the validator would refuse", async () => {
    // Same predicate as validateRedirectUri, so the two cannot disagree.
    const { registerClient } = await load();
    const r = await registerClient("x-app", "X", ["javascript:alert(1)"]);
    expect(r.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to shadow a built-in app id", async () => {
    const { registerClient } = await load();
    expect((await registerClient("fedihome-ios", "Fake", ["x://y"])).ok).toBe(false);
  });

  it("enforces uniqueness in code, since the column can't be @unique", async () => {
    // prisma db push is the upgrade path and refuses to add a unique constraint.
    findFirst.mockResolvedValue({ id: "row1", clientId: "dupe" });
    const { registerClient } = await load();
    expect((await registerClient("dupe", "D", ["d://cb"])).ok).toBe(false);
  });

  it("requires at least one redirect URI and caps how many", async () => {
    const { registerClient } = await load();
    expect((await registerClient("x-app", "X", [])).ok).toBe(false);
    expect((await registerClient("x-app", "X", Array(11).fill("x://y"))).ok).toBe(false);
  });

  it("clears the negative cache, so a new registration works immediately", async () => {
    const { registerClient, resolveClient } = await load();
    await resolveClient("later-app");           // caches the miss
    await registerClient("later-app", "L", ["l://cb"]);
    findFirst.mockResolvedValue({
      id: "r", clientId: "later-app", label: "L",
      redirectUris: ["l://cb"], createdAt: new Date(), lastUsedAt: null,
    });
    expect(await resolveClient("later-app")).not.toBeNull();
  });
});
