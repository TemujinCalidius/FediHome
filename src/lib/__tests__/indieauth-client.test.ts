import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * IndieAuth clients identified by URL (#494) — the other half of #366.
 *
 * Registration covers custom-scheme clients, which IndieAuth provably cannot:
 * it authenticates a client by fetching its `client_id`, and a custom scheme has
 * no document. The reverse holds too, which is what this is — Quill and
 * Micropublish have a stable URL client id, and the spec's whole point is that
 * fetching it proves the redirect belongs to that client.
 *
 * THE RISK, and what most of these tests are about: this is an outbound fetch to
 * a URL a stranger chose, PRE-AUTH, on an endpoint advertised to the entire web
 * via `rel="authorization_endpoint"`.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

const QUILL = "https://quill.p3k.io/";

const PAGE = `<!doctype html><html><head><title>Quill</title>
<link rel="redirect_uri" href="https://quill.p3k.io/auth/callback">
</head><body><div class="h-app"><a class="p-name" href="/">Quill</a></div></body></html>`;

async function load(over: { ok?: boolean; body?: string; link?: string | null; throws?: boolean } = {}) {
  const guardedFetch = vi.fn(async () => {
    if (over.throws) throw new Error("refusing non-public host");
    return {
      ok: over.ok ?? true,
      headers: { get: (h: string) => (h === "link" ? (over.link ?? null) : null) },
      text: async () => over.body ?? PAGE,
    };
  });
  vi.doMock("@/lib/safe-fetch", () => ({ guardedFetch }));
  const mod = await import("@/lib/indieauth-client");
  mod.resetIndieAuthCache();
  return { mod, guardedFetch };
}

beforeEach(() => vi.resetModules());

describe("isUrlClientId", () => {
  it("accepts an https URL", async () => {
    const { mod } = await load();
    expect(mod.isUrlClientId(QUILL)).toBe(true);
    expect(mod.isUrlClientId("https://micropublish.net/")).toBe(true);
  });

  it("accepts http only on loopback, for a client being developed locally", async () => {
    const { mod } = await load();
    expect(mod.isUrlClientId("http://127.0.0.1:8080/")).toBe(true);
    expect(mod.isUrlClientId("http://localhost:3000/")).toBe(true);
    // Anything else plaintext authenticates nothing — the document IS the proof.
    expect(mod.isUrlClientId("http://quill.p3k.io/")).toBe(false);
  });

  it("refuses a fragment", async () => {
    // A fragment isn't sent to the server, so two ids differing only there are
    // the same document — treating them as distinct is a cache-poisoning and
    // rate-limit-evasion primitive.
    const { mod } = await load();
    expect(mod.isUrlClientId("https://quill.p3k.io/#a")).toBe(false);
  });

  it("refuses userinfo", async () => {
    const { mod } = await load();
    expect(mod.isUrlClientId("https://user:pw@quill.p3k.io/")).toBe(false);
  });

  it("refuses dot segments in the path", async () => {
    const { mod } = await load();
    expect(mod.isUrlClientId("https://quill.p3k.io/a/../../b")).toBe(false);
    expect(mod.isUrlClientId("https://quill.p3k.io/./x")).toBe(false);
  });

  it("refuses a custom scheme — that is what registration is for", async () => {
    const { mod } = await load();
    expect(mod.isUrlClientId("obsidian://cb")).toBe(false);
    expect(mod.isUrlClientId("fedihome-macos")).toBe(false);
  });
});

describe("resolveUrlClient", () => {
  it("reads the app name and the declared redirect URIs", async () => {
    const { mod } = await load();
    const c = await mod.resolveUrlClient(QUILL, "ip");
    expect(c?.kind).toBe("indieauth");
    expect(c?.label).toBe("Quill");
    expect(c?.id).toBe(QUILL);
    expect(c?.redirectSchemes).toContain("https://quill.p3k.io/auth/callback");
  });

  it("falls back to the title, then the hostname", async () => {
    const { mod } = await load({ body: "<html><head><title>Micropublish</title></head></html>" });
    expect((await mod.resolveUrlClient(QUILL, "ip"))?.label).toBe("Micropublish");

    vi.resetModules();
    const second = await load({ body: "<html></html>" });
    expect((await second.mod.resolveUrlClient(QUILL, "ip"))?.label).toBe("quill.p3k.io");
  });

  it("treats a fetch failure as UNKNOWN, never as permission", async () => {
    const { mod } = await load({ throws: true });
    expect(await mod.resolveUrlClient(QUILL, "ip")).toBeNull();

    vi.resetModules();
    const notOk = await load({ ok: false });
    expect(await notOk.mod.resolveUrlClient(QUILL, "ip")).toBeNull();
  });

  it("goes through guardedFetch with a timeout, not a bare fetch", async () => {
    // The URL comes from a stranger, pre-auth. guardedFetch re-validates every
    // redirect hop (#433/#434).
    const { mod, guardedFetch } = await load();
    await mod.resolveUrlClient(QUILL, "ip");
    expect(guardedFetch).toHaveBeenCalledWith(
      QUILL,
      expect.objectContaining({ crossOrigin: true, timeoutMs: expect.any(Number) }),
    );
  });

  it("caches a hit, so a repeat costs no fetch", async () => {
    const { mod, guardedFetch } = await load();
    await mod.resolveUrlClient(QUILL, "ip");
    await mod.resolveUrlClient(QUILL, "ip");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("caches a MISS too, so a bad id isn't re-fetched every request", async () => {
    const { mod, guardedFetch } = await load({ ok: false });
    await mod.resolveUrlClient(QUILL, "ip");
    await mod.resolveUrlClient(QUILL, "ip");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("rate-limits the FETCH, which caching alone cannot cover", async () => {
    // #366 could rely on a negative cache because an unknown id cost one indexed
    // query. A fetch is orders of magnitude dearer, and caching only helps for
    // ids that REPEAT — the abusive case is ids that never do.
    const { mod, guardedFetch } = await load();
    for (let i = 0; i < 30; i++) await mod.resolveUrlClient(`https://c${i}.example/`, "one-ip");
    expect(guardedFetch.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it("spends the budget per caller, so one abuser can't lock everyone out", async () => {
    const { mod, guardedFetch } = await load();
    for (let i = 0; i < 30; i++) await mod.resolveUrlClient(`https://c${i}.example/`, "abuser");
    const before = guardedFetch.mock.calls.length;
    expect(await mod.resolveUrlClient("https://legit.example/", "someone-else")).not.toBeNull();
    expect(guardedFetch.mock.calls.length).toBe(before + 1);
  });

  it("does not spend the budget on a cache hit", async () => {
    // A client the owner actually uses must not be refused for being popular.
    const { mod, guardedFetch } = await load();
    for (let i = 0; i < 12; i++) await mod.resolveUrlClient(`https://c${i}.example/`, "ip");
    const spent = guardedFetch.mock.calls.length;
    for (let i = 0; i < 50; i++) await mod.resolveUrlClient("https://c0.example/", "ip");
    expect(guardedFetch.mock.calls.length).toBe(spent);
  });

  it("caps the body it reads", async () => {
    const { mod } = await load({ body: "x".repeat(5_000_000) });
    // Doesn't hang or explode; falls through to the hostname for a name.
    expect((await mod.resolveUrlClient(QUILL, "ip"))?.label).toBe("quill.p3k.io");
  });
});

describe("parseRedirectUris", () => {
  it("reads a rel=redirect_uri link in either attribute order", async () => {
    const { mod } = await load();
    expect(mod.parseRedirectUris('<link rel="redirect_uri" href="https://a.example/cb">', null))
      .toEqual(["https://a.example/cb"]);
    expect(mod.parseRedirectUris('<link href="https://a.example/cb" rel="redirect_uri">', null))
      .toEqual(["https://a.example/cb"]);
  });

  it("reads the Link header too — a client that uses only it isn't broken", async () => {
    const { mod } = await load();
    expect(
      mod.parseRedirectUris("", '<https://a.example/cb>; rel="redirect_uri"'),
    ).toEqual(["https://a.example/cb"]);
  });

  it("ignores links with a different rel", async () => {
    const { mod } = await load();
    expect(mod.parseRedirectUris('<link rel="stylesheet" href="/x.css">', null)).toEqual([]);
  });
});

describe("validateRedirectUri — the third matching mode", () => {
  const client = (over: Record<string, unknown> = {}) =>
    ({
      id: QUILL,
      label: "Quill",
      kind: "indieauth",
      redirectSchemes: ["https://other.example/cb"],
      redirectUris: ["https://other.example/cb"],
      allowLoopback: false,
      loopbackPath: "",
      ...over,
    }) as never;

  it("accepts any redirect on the client_id's OWN origin", async () => {
    const { validateRedirectUri } = await import("@/lib/oauth");
    expect(validateRedirectUri(client(), "https://quill.p3k.io/auth/anything")).toBe(true);
  });

  it("accepts a cross-origin redirect only when the document declared it", async () => {
    const { validateRedirectUri } = await import("@/lib/oauth");
    expect(validateRedirectUri(client(), "https://other.example/cb")).toBe(true);
    expect(validateRedirectUri(client(), "https://other.example/elsewhere")).toBe(false);
  });

  it("compares ORIGINS, not string prefixes", async () => {
    // THE bug this mode could have had: `https://quill.p3k.io` is a prefix of
    // `https://quill.p3k.io.evil.example`, so prefix-matching would hand the
    // authorization code to whoever owns the longer domain.
    const { validateRedirectUri } = await import("@/lib/oauth");
    expect(validateRedirectUri(client(), "https://quill.p3k.io.evil.example/cb")).toBe(false);
    // A different port and a different scheme are different origins too.
    expect(validateRedirectUri(client(), "https://quill.p3k.io:8443/cb")).toBe(false);
    expect(validateRedirectUri(client(), "http://quill.p3k.io/cb")).toBe(false);
  });

  it("still refuses a dangerous scheme, whatever the client kind", async () => {
    const { validateRedirectUri } = await import("@/lib/oauth");
    expect(validateRedirectUri(client(), "javascript:alert(1)")).toBe(false);
  });

  it("does NOT widen a REGISTERED client to its whole origin", async () => {
    // Same-origin matching is scoped to `kind === "indieauth"` on purpose.
    // Applying it to a registration would silently turn "these exact URIs" into
    // "this whole origin", which is more than the owner was asked to assert.
    const { validateRedirectUri } = await import("@/lib/oauth");
    const registered = client({ kind: "registered", id: "https://app.example/" });
    expect(validateRedirectUri(registered, "https://app.example/anything")).toBe(false);
  });
});

describe("#494 — the wiring", () => {
  it("the authorize route threads a rate-limit key into client resolution", () => {
    // GET has no rate limit of its own, which was safe while an unknown id cost
    // zero queries. A URL id costs a fetch.
    const src = read("src/app/api/oauth/authorize/route.ts");
    expect(src).toContain("validate(p, rateLimitKey(req))");
    expect(src.match(/validate\(p, rateLimitKey\(req\)\)/g)?.length).toBe(2);
  });

  it("resolveClient skips the fetch branch entirely without a key", () => {
    // Nothing that doesn't pass a key can be walked into an outbound request.
    const src = read("src/lib/oauth-clients.ts");
    expect(src).toContain("if (rateKey && isUrlClientId(clientId))");
  });

  it("the consent screen says which KIND of client it is", () => {
    // The three mean different things to the person approving, and the screen
    // used to render all three identically as a label.
    const src = read("src/app/api/oauth/authorize/route.ts");
    expect(src).toContain("provenanceNote");
    // The URL is shown, because the NAME came from a page a stranger controls.
    const note = src.slice(src.indexOf("function provenanceNote"), src.indexOf("function consentPage"));
    expect(note).toContain("escapeHtml(client.id)");
  });

  it("the client_id fetch is covered by the SSRF call-site sweep", () => {
    expect(read("src/lib/__tests__/ssrf-call-sites.test.ts")).toContain("src/lib/indieauth-client.ts");
  });
});
