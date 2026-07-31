import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";

/**
 * Redirect handling for the two signed outbound helpers.
 *
 * Both used to call `assertPublicHost()` once and hand the URL to `fetch()`, which
 * follows redirects by default. That validated the FIRST hop only — so a host that
 * passed the check could bounce the request anywhere, including loopback or a cloud
 * metadata endpoint. The GET path was the worse of the two, because its response
 * body is parsed as an actor document: an internal endpoint's response came back
 * into the app.
 *
 * Neither URL is ours. An actor URI arrives inside an inbox activity; the inbox we
 * deliver to comes out of a fetched actor document. So the entry point is any
 * server we federate with.
 *
 * `assertPublicHost` is mocked to accept the FIRST host and reject the redirect
 * target — which is exactly the real shape: the attacker's own domain resolves
 * publicly, and only the hop after it is private.
 */

const { assertPublicHost } = vi.hoisted(() => ({ assertPublicHost: vi.fn() }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost }));

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
vi.mock("@/lib/db", () => ({
  prisma: { actorKeys: { findUnique: vi.fn(async () => ({ id: "main", privateKey, publicKey: "PUB" })) } },
}));
vi.mock("@/lib/identity", () => ({
  getIdentity: () => ({ keyId: "https://me.example/ap/actor#main-key" }),
  getSiteUrl: () => "https://me.example",
}));
vi.mock("@/lib/blocks", () => ({ blockedRecipient: vi.fn(), partitionBlockedRecipients: vi.fn() }));

import { signedFetch, signedGet } from "@/lib/http-signatures";

/** A request the second server actually received. */
interface Hit {
  method: string;
  url: string;
  host?: string;
  signature?: string;
}

let target: http.Server;
let targetPort = 0;
let hits: Hit[] = [];

/** Where `redirector` sends things, and how many times. */
let redirectTo: (() => string) | null = null;
let redirectChain = 0;
let redirector: http.Server;
let redirectorPort = 0;

const record = (req: http.IncomingMessage): Hit => ({
  method: req.method!,
  url: req.url!,
  host: req.headers.host,
  signature: req.headers.signature as string | undefined,
});

beforeAll(async () => {
  target = http.createServer((req, res) => {
    hits.push(record(req));
    res.writeHead(200, { "content-type": "application/activity+json" });
    res.end(JSON.stringify({ id: "internal", preferredUsername: "SHOULD-NOT-BE-READ" }));
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  targetPort = (target.address() as { port: number }).port;

  redirector = http.createServer((req, res) => {
    if (redirectChain > 0) {
      redirectChain--;
      res.writeHead(302, { location: `http://127.0.0.1:${redirectorPort}/again` });
      res.end();
      return;
    }
    if (redirectTo) {
      res.writeHead(302, { location: redirectTo() });
      res.end();
      return;
    }
    hits.push(record(req));
    res.writeHead(200, { "content-type": "application/activity+json" });
    res.end(JSON.stringify({ id: "ok", preferredUsername: "legit" }));
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", () => r()));
  redirectorPort = (redirector.address() as { port: number }).port;
});

afterAll(() => {
  target.close();
  redirector.close();
});

beforeEach(() => {
  assertPublicHost.mockClear(); // call counts are asserted, so don't let them accumulate
  hits = [];
  redirectTo = null;
  redirectChain = 0;
  // Accept the entry host; reject anything else — i.e. the redirect target is private.
  assertPublicHost.mockImplementation(async (u: string) => u.includes(`:${redirectorPort}`));
});

const entry = (path = "/actor") => `http://127.0.0.1:${redirectorPort}${path}`;
const privateTarget = () => `http://127.0.0.1:${targetPort}/latest/meta-data/`;

describe("signedGet — the response body is parsed, so this is the one that leaks", () => {
  it("REFUSES a redirect to a host that fails the public-host check", async () => {
    redirectTo = privateTarget;
    await expect(signedGet(entry())).rejects.toThrow(/non-public host/);
    // The decisive assertion: the internal server was never contacted at all.
    expect(hits).toHaveLength(0);
  });

  it("checks EVERY hop, not just the first", async () => {
    // Before the fix this was one `assertPublicHost` call, ever.
    redirectTo = privateTarget;
    await signedGet(entry()).catch(() => {});
    expect(assertPublicHost).toHaveBeenCalledTimes(2);
    expect(assertPublicHost.mock.calls[1][0]).toContain(`:${targetPort}`);
  });

  it("still follows a legitimate cross-host redirect, re-signed for the new URL", async () => {
    // Actor URLs really do redirect, so this must keep working.
    assertPublicHost.mockResolvedValue(true);
    redirectTo = () => `http://127.0.0.1:${targetPort}/users/ada`;
    const res = await signedGet(entry());
    expect(res.status).toBe(200);
    expect(hits).toHaveLength(1);
    // Re-signed: the signature is for the hop that was actually requested.
    expect(hits[0].url).toBe("/users/ada");
    expect(hits[0].host).toBe(`127.0.0.1:${targetPort}`);
    expect(hits[0].signature).toContain('headers="(request-target) host date"');
  });

  it("gives up rather than following a redirect loop", async () => {
    assertPublicHost.mockResolvedValue(true);
    redirectChain = 10;
    await expect(signedGet(entry())).rejects.toThrow(/too many redirects/);
  });

  it("refuses a non-http(s) redirect target", async () => {
    assertPublicHost.mockResolvedValue(true);
    redirectTo = () => "file:///etc/passwd";
    await expect(signedGet(entry())).rejects.toThrow(/refusing redirect to file:/);
  });

  it("returns a 3xx with no Location rather than throwing", async () => {
    assertPublicHost.mockResolvedValue(true);
    redirectTo = null;
    redirectChain = 0;
    const res = await signedGet(entry());
    expect(res.status).toBe(200);
  });
});

describe("signedFetch — delivery, where a cross-host redirect has no legitimate use", () => {
  it("REFUSES a redirect to a host that fails the public-host check", async () => {
    redirectTo = privateTarget;
    await expect(signedFetch(entry("/inbox"), "{}")).rejects.toThrow(/non-public|cross-host/);
    expect(hits).toHaveLength(0);
  });

  it("refuses a CROSS-HOST redirect even when the target is perfectly public", async () => {
    // Following it would hand any peer a way to make us produce a validly-signed
    // request aimed at a host of their choosing. Nothing in ActivityPub needs it.
    assertPublicHost.mockResolvedValue(true);
    redirectTo = () => `http://127.0.0.2:${targetPort}/inbox`;
    await expect(signedFetch(entry("/inbox"), "{}")).rejects.toThrow(/cross-host redirect/);
    expect(hits).toHaveLength(0);
  });

  it("still follows a same-host redirect, re-signed and with the body intact", async () => {
    assertPublicHost.mockResolvedValue(true);
    redirectChain = 1; // /inbox -> /again on the same host
    const res = await signedFetch(entry("/inbox"), JSON.stringify({ type: "Follow" }));
    expect(res.status).toBe(200);
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe("POST");
    expect(hits[0].url).toBe("/again");
    expect(hits[0].signature).toContain("digest");
  });
});
