import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  sanitizeScope,
  getClient,
  validateRedirectUri,
  isValidCodeChallenge,
  verifyPkceS256,
  makeRateLimiter,
  escapeHtml,
  SUPPORTED_SCOPES,
} from "../oauth";

const macos = getClient("fedihome-macos")!;

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url"); // 43 chars
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("sanitizeScope", () => {
  it("keeps only supported scopes, de-duped, in canonical order", () => {
    expect(sanitizeScope("dm read read create bogus")).toBe("read create dm");
  });
  it("returns '' for nothing valid (→ invalid_scope)", () => {
    expect(sanitizeScope("bogus nonsense")).toBe("");
    expect(sanitizeScope("")).toBe("");
    expect(sanitizeScope(null)).toBe("");
  });
  it("never invents a scope that wasn't asked for", () => {
    expect(sanitizeScope("read").split(" ")).toEqual(["read"]);
  });
});

describe("getClient / client allowlist", () => {
  it("resolves the three first-party clients", () => {
    expect(getClient("fedihome-macos")?.label).toMatch(/macOS/);
    expect(getClient("fedihome-ios")?.label).toMatch(/iOS/);
    expect(getClient("fedihome-android")?.label).toMatch(/Android/);
  });
  it("rejects unknown / empty client ids", () => {
    expect(getClient("evil")).toBeNull();
    expect(getClient("")).toBeNull();
    expect(getClient(null)).toBeNull();
  });
});

describe("validateRedirectUri", () => {
  it("accepts the exact registered custom scheme", () => {
    expect(validateRedirectUri(macos, "fedihome-macos://callback")).toBe(true);
  });
  it("rejects near-miss custom schemes", () => {
    expect(validateRedirectUri(macos, "fedihome-macos://callback/")).toBe(false);
    expect(validateRedirectUri(macos, "fedihome-macos://evil")).toBe(false);
    expect(validateRedirectUri(macos, "fedihome-ios://callback")).toBe(false);
  });
  it("accepts loopback on any port (IPv4 + IPv6)", () => {
    expect(validateRedirectUri(macos, "http://127.0.0.1:52000/callback")).toBe(true);
    expect(validateRedirectUri(macos, "http://127.0.0.1/callback")).toBe(true);
    expect(validateRedirectUri(macos, "http://[::1]:3000/callback")).toBe(true);
  });
  it("rejects non-loopback hosts, https, wrong path, query, and userinfo", () => {
    expect(validateRedirectUri(macos, "http://localhost:3000/callback")).toBe(false);
    expect(validateRedirectUri(macos, "http://evil.com/callback")).toBe(false);
    expect(validateRedirectUri(macos, "https://127.0.0.1/callback")).toBe(false);
    expect(validateRedirectUri(macos, "http://127.0.0.1:3000/wrong")).toBe(false);
    expect(validateRedirectUri(macos, "http://127.0.0.1:3000/callback?x=1")).toBe(false);
    expect(validateRedirectUri(macos, "http://user:pass@127.0.0.1/callback")).toBe(false);
    expect(validateRedirectUri(macos, "http://:@127.0.0.1/callback")).toBe(false); // empty-but-present userinfo
    expect(validateRedirectUri(macos, "not a url")).toBe(false);
    expect(validateRedirectUri(macos, "")).toBe(false);
  });
});

describe("PKCE S256", () => {
  it("accepts a well-formed 43-char base64url challenge", () => {
    const { challenge } = pkcePair();
    expect(isValidCodeChallenge(challenge)).toBe(true);
  });
  it("rejects malformed challenges", () => {
    expect(isValidCodeChallenge("short")).toBe(false);
    expect(isValidCodeChallenge("a".repeat(43) + "=")).toBe(false); // padding
    expect(isValidCodeChallenge("a/b+c".padEnd(43, "a"))).toBe(false); // non-url chars
    expect(isValidCodeChallenge(null)).toBe(false);
  });
  it("verifies the correct verifier and rejects the wrong one", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(verifier + "x", challenge)).toBe(false);
    expect(verifyPkceS256(pkcePair().verifier, challenge)).toBe(false);
  });
  it("rejects a verifier that is too short (< 43 chars)", () => {
    const short = "abc";
    const challenge = crypto.createHash("sha256").update(short).digest("base64url");
    expect(verifyPkceS256(short, challenge)).toBe(false);
  });
});

describe("makeRateLimiter", () => {
  it("allows up to max within the window, then blocks, then resets", () => {
    const rl = makeRateLimiter(3, 1000);
    const t0 = 1_000_000;
    expect(rl.check("k", t0)).toBe(true);
    expect(rl.check("k", t0)).toBe(true);
    expect(rl.check("k", t0)).toBe(true);
    expect(rl.check("k", t0)).toBe(false); // 4th in window
    expect(rl.check("k", t0 + 1001)).toBe(true); // window rolled over
  });
  it("keys are independent", () => {
    const rl = makeRateLimiter(1, 1000);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("b", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes the dangerous five", () => {
    expect(escapeHtml(`<script>"x"&'y'`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;");
  });
});

describe("discovery metadata (RFC 8414)", () => {
  it("advertises S256-only PKCE + the three endpoints", async () => {
    process.env.SITE_URL = "https://demo.example";
    const { GET } = await import("@/app/.well-known/oauth-authorization-server/route");
    const res = await GET();
    const j = await res.json();
    expect(j.authorization_endpoint).toBe("https://demo.example/api/oauth/authorize");
    expect(j.token_endpoint).toBe("https://demo.example/api/oauth/token");
    expect(j.revocation_endpoint).toBe("https://demo.example/api/oauth/revoke");
    expect(j.code_challenge_methods_supported).toEqual(["S256"]);
    expect(j.grant_types_supported).toEqual(["authorization_code"]);
    expect(j.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
  });
});
