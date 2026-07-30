import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";

/**
 * The shared redirect guard.
 *
 * Nine outbound call sites had the same shape — `assertPublicHost(url)` once, then
 * `fetch()`, which follows redirects by default. So the guard validated the FIRST
 * hop and nothing else: a host that passed could answer `302 Location:
 * http://169.254.169.254/` and the request went there unchecked.
 *
 * None of those URLs are ours. The cheapest entry point needs no relationship at
 * all — one signed POST to `/ap/inbox` from anywhere on the internet makes us fetch
 * the signer's key from a URL they chose.
 *
 * `assertPublicHost` is mocked to accept the FIRST host and reject the redirect
 * target, which is the real shape: the attacker's own domain resolves publicly and
 * only the hop after it is private.
 */

const { assertPublicHost } = vi.hoisted(() => ({ assertPublicHost: vi.fn() }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost }));

import { guardedFetch, guardedFetchJson, isPolicyRefusal, MAX_REDIRECT_HOPS } from "@/lib/safe-fetch";

let internal: http.Server, redirector: http.Server;
let internalPort = 0, redirectorPort = 0;
let internalHits: string[] = [];
let redirectTo: (() => string) | null = null;
let chain = 0;

beforeAll(async () => {
  internal = http.createServer((req, res) => {
    internalHits.push(req.url!);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ secret: "internal-only", preferredUsername: "LEAKED" }));
  });
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", () => r()));
  internalPort = (internal.address() as { port: number }).port;

  redirector = http.createServer((req, res) => {
    if (chain > 0) {
      chain--;
      res.writeHead(302, { location: `http://127.0.0.1:${redirectorPort}/hop` });
      res.end();
      return;
    }
    if (redirectTo) {
      res.writeHead(302, { location: redirectTo() });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", () => r()));
  redirectorPort = (redirector.address() as { port: number }).port;
});

afterAll(() => { internal.close(); redirector.close(); });

beforeEach(() => {
  assertPublicHost.mockClear();
  internalHits = [];
  redirectTo = null;
  chain = 0;
  // Entry host passes; the redirect target is "private".
  assertPublicHost.mockImplementation(async (u: string) => u.includes(`:${redirectorPort}`));
});

const entry = (path = "/actor") => `http://127.0.0.1:${redirectorPort}${path}`;
const privateTarget = () => `http://127.0.0.1:${internalPort}/latest/meta-data/`;

describe("the per-hop check", () => {
  it("REFUSES a redirect into a host that fails the check", async () => {
    redirectTo = privateTarget;
    await expect(guardedFetch(entry(), { crossOrigin: true, label: "t", timeoutMs: 5000 }))
      .rejects.toThrow(/refusing non-public host/);
    // The decisive assertion: the internal server was never contacted.
    expect(internalHits).toEqual([]);
  });

  it("checks EVERY hop, not just the first", async () => {
    // Before the fix, this was one call — ever.
    redirectTo = privateTarget;
    await guardedFetch(entry(), { crossOrigin: true, label: "t", timeoutMs: 5000 }).catch(() => {});
    expect(assertPublicHost).toHaveBeenCalledTimes(2);
    expect(assertPublicHost.mock.calls[1][0]).toContain(`:${internalPort}`);
  });

  it("checks the hop AFTER a same-host redirect too", async () => {
    assertPublicHost.mockResolvedValue(true);
    chain = 2;
    await guardedFetch(entry(), { crossOrigin: true, label: "t", timeoutMs: 5000 });
    expect(assertPublicHost).toHaveBeenCalledTimes(3);
  });
});

describe("what it still allows", () => {
  it("follows a legitimate cross-host redirect when crossOrigin is set", async () => {
    assertPublicHost.mockResolvedValue(true);
    redirectTo = () => `http://127.0.0.1:${internalPort}/users/ada`;
    const res = await guardedFetch(entry(), { crossOrigin: true, label: "t", timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(internalHits).toEqual(["/users/ada"]);
  });

  it("refuses a cross-host redirect when crossOrigin is NOT set", async () => {
    // Writes use this: nothing in ActivityPub needs delivery to follow a cross-host
    // redirect, and allowing it lets a peer aim our request at a host they choose.
    assertPublicHost.mockResolvedValue(true);
    redirectTo = () => `http://127.0.0.2:${internalPort}/inbox`;
    await expect(guardedFetch(entry(), { crossOrigin: false, label: "t", timeoutMs: 5000 }))
      .rejects.toThrow(/refusing cross-host redirect/);
    expect(internalHits).toEqual([]);
  });

  it("allows a same-host redirect even when crossOrigin is not set", async () => {
    assertPublicHost.mockResolvedValue(true);
    chain = 1;
    const res = await guardedFetch(entry("/inbox"), { crossOrigin: false, label: "t", timeoutMs: 5000 });
    expect(res.status).toBe(200);
  });
});

describe("the other ways a redirect can go wrong", () => {
  it("gives up rather than following a loop", async () => {
    assertPublicHost.mockResolvedValue(true);
    chain = 99;
    await expect(guardedFetch(entry(), { crossOrigin: true, label: "t", timeoutMs: 5000 }))
      .rejects.toThrow(/too many redirects/);
  });

  it("honours a caller's higher hop cap (media chains through CDNs)", async () => {
    assertPublicHost.mockResolvedValue(true);
    chain = MAX_REDIRECT_HOPS + 1;
    const res = await guardedFetch(entry(), { crossOrigin: true, label: "t", timeoutMs: 5000, maxHops: 5 });
    expect(res.status).toBe(200);
  });

  it("refuses a non-http(s) redirect target", async () => {
    assertPublicHost.mockResolvedValue(true);
    redirectTo = () => "file:///etc/passwd";
    await expect(guardedFetch(entry(), { crossOrigin: true, label: "t", timeoutMs: 5000 }))
      .rejects.toThrow(/refusing redirect to file:/);
  });

  it("returns a 3xx that carries no Location rather than throwing", async () => {
    assertPublicHost.mockResolvedValue(true);
    const s = http.createServer((_req, res) => { res.writeHead(302); res.end(); });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as { port: number }).port;
    const res = await guardedFetch(`http://127.0.0.1:${port}/x`, { crossOrigin: true, label: "t", timeoutMs: 5000 });
    expect(res.status).toBe(302);
    s.close();
  });

  it("names the caller in the error, so a log line says who refused", async () => {
    redirectTo = privateTarget;
    await expect(guardedFetch(entry(), { crossOrigin: true, label: "keyId fetch", timeoutMs: 5000 }))
      .rejects.toThrow(/^keyId fetch:/);
  });

  it("rejects an unparseable URL without calling out", async () => {
    await expect(guardedFetch("not a url", { crossOrigin: true, label: "t", timeoutMs: 5000 }))
      .rejects.toThrow(/unparseable URL/);
    expect(assertPublicHost).not.toHaveBeenCalled();
  });
});

describe("guardedFetchJson", () => {
  it("returns null rather than throwing when a hop is refused", async () => {
    // Every caller it replaced already degraded silently to null.
    redirectTo = privateTarget;
    expect(await guardedFetchJson(entry(), { label: "t", timeoutMs: 5000 })).toBeNull();
    expect(internalHits).toEqual([]);
  });

  it("returns the parsed body on success", async () => {
    assertPublicHost.mockResolvedValue(true);
    const body = await guardedFetchJson<{ ok: boolean }>(entry(), { label: "t", timeoutMs: 5000 });
    expect(body?.ok).toBe(true);
  });
});

describe("which refusals are permanent", () => {
  it("a STRUCTURAL refusal is permanent — retrying cannot change it", async () => {
    // Decided from bytes we already hold. A cross-host redirect won't be a same-host
    // one in ninety minutes, so re-attempting it for a day and a half is pure waste.
    assertPublicHost.mockResolvedValue(true);
    redirectTo = () => `http://127.0.0.2:${internalPort}/inbox`;
    await expect(guardedFetch(entry(), { crossOrigin: false, label: "t", timeoutMs: 5000 }))
      .rejects.toSatisfy(isPolicyRefusal);
  });

  it("a NON-PUBLIC-HOST refusal is NOT permanent, because it may be a DNS blip", async () => {
    // THE important one. assertPublicHost returns false for "the lookup failed"
    // exactly as it does for "this resolves to 127.0.0.1" — EAI_AGAIN and SERVFAIL
    // are indistinguishable from a private address. Calling that permanent makes
    // enqueueFailedDeliveries drop the activity with no row and no retry, so a single
    // resolver hiccup mid-fan-out silently loses the post to that follower.
    redirectTo = privateTarget;
    await expect(guardedFetch(entry(), { crossOrigin: true, label: "t", timeoutMs: 5000 }))
      .rejects.toSatisfy((e) => !isPolicyRefusal(e));
  });

  it("does NOT mark a transport failure either", async () => {
    assertPublicHost.mockResolvedValue(true);
    // Nothing listening: a real connection error, not a policy decision.
    await expect(
      guardedFetch("http://127.0.0.1:1/x", { crossOrigin: true, label: "t", timeoutMs: 1000 }),
    ).rejects.toSatisfy((e) => !isPolicyRefusal(e));
  });

  it("bounds the WHOLE chain, not each hop", async () => {
    // A per-hop signal multiplies the budget by the hop count. The inbox key fetch
    // passes 8s to bound a slowloris; four hops of 8s would make that 32s of held
    // request on a path any unauthenticated peer can trigger.
    assertPublicHost.mockResolvedValue(true);
    chain = 99;
    const started = Date.now();
    await expect(guardedFetch(entry(), { crossOrigin: true, label: "t", timeoutMs: 300, maxHops: 50 }))
      .rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000); // one budget, not fifty
  });
});
