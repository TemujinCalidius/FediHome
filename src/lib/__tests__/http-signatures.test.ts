import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

vi.mock("@/lib/url-guard", () => ({ assertPublicHost: vi.fn().mockResolvedValue(true) }));
// verifyIncomingSignature reads actor keys only via the signer fetch (mocked
// global fetch), so no DB is needed — but the module imports prisma.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { verifyIncomingSignature, actorMatchesSigner } from "@/lib/http-signatures";

// One RSA keypair standing in for a remote signer.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const INBOX = "https://me.example/ap/inbox";

/** Build a validly HTTP-signed POST to our inbox, signed by `keyId`'s key. */
function signedRequest(keyId: string, body: string, dateOverride?: string): Request {
  const url = new URL(INBOX);
  const date = dateOverride ?? new Date().toUTCString();
  const digest = "SHA-256=" + crypto.createHash("sha256").update(body).digest("base64");
  const signingString = [
    `(request-target): post ${url.pathname}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");
  const signature = crypto.createSign("sha256").update(signingString).sign(privateKey, "base64");
  const signatureHeader = [
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="(request-target) host date digest"`,
    `signature="${signature}"`,
  ].join(",");
  return new Request(INBOX, {
    method: "POST",
    headers: { Host: url.host, Date: date, Digest: digest, Signature: signatureHeader, "Content-Type": "application/activity+json" },
    body,
  });
}

/** Mock the signer's actor-document fetch to return `doc` (with our public key). */
function mockActorDoc(doc: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ publicKey: { publicKeyPem: publicKey }, ...doc }), { status: 200 })),
  );
}

const BODY = JSON.stringify({ type: "Create", actor: "https://remote.example/users/ada" });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("verifyIncomingSignature — actor binding (#209)", () => {
  it("returns the key's owner for a standard Mastodon-shaped actor", async () => {
    mockActorDoc({ id: "https://remote.example/users/ada", publicKey: { publicKeyPem: publicKey, owner: "https://remote.example/users/ada" } });
    const res = await verifyIncomingSignature(signedRequest("https://remote.example/users/ada#main-key", BODY), BODY);
    expect(res).toEqual({ valid: true, actorUri: "https://remote.example/users/ada" });
  });

  it("uses the key owner even when the keyId path differs from the actor id (same host)", async () => {
    // keyId at /keys/1 but the doc's owner is the actor — compatibility case.
    mockActorDoc({ id: "https://remote.example/users/ada", publicKey: { publicKeyPem: publicKey, owner: "https://remote.example/users/ada" } });
    const res = await verifyIncomingSignature(signedRequest("https://remote.example/keys/1", BODY), BODY);
    expect(res).toEqual({ valid: true, actorUri: "https://remote.example/users/ada" });
  });

  it("REFUSES a cross-host owner claim — falls back to the fetch URL (can't spoof another instance's actor)", async () => {
    // evil.example serves a doc claiming to be owned by victim.social/celebrity.
    mockActorDoc({ id: "https://victim.social/users/celebrity", publicKey: { publicKeyPem: publicKey, owner: "https://victim.social/users/celebrity" } });
    const res = await verifyIncomingSignature(signedRequest("https://evil.example/key", BODY), BODY);
    // Owner is on a different host than the key URL → not trusted → fetch URL used.
    expect(res).toEqual({ valid: true, actorUri: "https://evil.example/key" });
  });

  it("rejects a tampered body (digest mismatch)", async () => {
    mockActorDoc({ id: "https://remote.example/users/ada" });
    const req = signedRequest("https://remote.example/users/ada#main-key", BODY);
    const res = await verifyIncomingSignature(req, BODY + "tampered");
    expect(res.valid).toBe(false);
  });

  it("rejects a stale Date outside the replay window", async () => {
    mockActorDoc({ id: "https://remote.example/users/ada" });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toUTCString();
    const res = await verifyIncomingSignature(signedRequest("https://remote.example/users/ada#main-key", BODY, old), BODY);
    expect(res.valid).toBe(false);
  });
});

describe("actorMatchesSigner — exact binding (#209)", () => {
  it("matches the same actor (host case-insensitive, trailing slash ignored)", () => {
    expect(actorMatchesSigner("https://Host.Example/users/ada", "https://host.example/users/ada/")).toBe(true);
  });

  it("REJECTS a different actor on the SAME host (the #209 same-host spoof)", () => {
    expect(actorMatchesSigner("https://mastodon.social/users/attacker", "https://mastodon.social/users/celebrity")).toBe(false);
  });

  it("compares the PATH case-SENSITIVELY (Mastodon paths are case-sensitive) — guards against a future lowercase 'cleanup'", () => {
    expect(actorMatchesSigner("https://h.example/users/Ada", "https://h.example/users/ada")).toBe(false);
  });

  it("rejects a different host", () => {
    expect(actorMatchesSigner("https://evil.example/users/ada", "https://good.example/users/ada")).toBe(false);
  });

  it("rejects garbage URIs", () => {
    expect(actorMatchesSigner("not-a-url", "also-not")).toBe(false);
  });
});
