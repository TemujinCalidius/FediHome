import crypto from "crypto";
import { safeCompare } from "./auth";

/**
 * OAuth 2.0 (Authorization-Code + PKCE, IndieAuth-compatible) building blocks
 * for the native-app token flow. Everything security-relevant that both the
 * /authorize and /token endpoints must agree on lives here, so the rules can't
 * drift between the two halves of the exchange.
 */

// === Scopes ===
// Space-separated, matched with `hasScope`. `create/update/delete/media` are the
// existing Micropub scopes; `read` covers feed/notifications/conversations/graph/
// counts/account; `interact` like/boost/reply/follow/block; `dm` messages;
// `manage` comment moderation + maintenance.
export const SUPPORTED_SCOPES = [
  "read",
  "create",
  "update",
  "delete",
  "media",
  "interact",
  "dm",
  "manage",
] as const;

/** The full set a first-party app asks for. */
export const APP_FULL_SCOPE = SUPPORTED_SCOPES.join(" ");

/**
 * Keep only recognised scope tokens, de-duplicated and in canonical order.
 * Returns "" when nothing valid was requested (the caller treats that as
 * `invalid_scope`) — we never silently grant something that wasn't asked for.
 */
export function sanitizeScope(requested: string | null | undefined): string {
  const asked = new Set((requested ?? "").split(/\s+/).filter(Boolean));
  return SUPPORTED_SCOPES.filter((s) => asked.has(s)).join(" ");
}

// === First-party client allowlist ===
// Native, PUBLIC clients (no client secret) → PKCE-protected. Redirect URIs are
// validated by EXACT match against `redirectSchemes`, or (per RFC 8252) against a
// loopback-IP http URI on any port with an exact path. No arbitrary web redirects
// → no open-redirect surface. Third-party IndieAuth clients are deferred.
export interface OAuthClient {
  id: string;
  label: string;
  /** Exact-match custom-scheme redirect URIs. */
  redirectSchemes: string[];
  /** Allow `http://127.0.0.1:<any-port><loopbackPath>` (and ::1). */
  allowLoopback: boolean;
  loopbackPath: string;
}

const CLIENTS: readonly OAuthClient[] = [
  {
    id: "fedihome-macos",
    label: "FediHome for macOS",
    redirectSchemes: ["fedihome-macos://callback"],
    allowLoopback: true,
    loopbackPath: "/callback",
  },
  {
    id: "fedihome-ios",
    label: "FediHome for iOS",
    redirectSchemes: ["fedihome-ios://callback"],
    allowLoopback: true,
    loopbackPath: "/callback",
  },
  {
    id: "fedihome-android",
    label: "FediHome for Android",
    redirectSchemes: ["fedihome-android://callback"],
    allowLoopback: true,
    loopbackPath: "/callback",
  },
] as const;

export function getClient(clientId: string | null | undefined): OAuthClient | null {
  if (!clientId) return null;
  return CLIENTS.find((c) => c.id === clientId) ?? null;
}

/**
 * Exact-match the redirect URI against the client's registration. Custom schemes
 * must match verbatim; loopback URIs may vary only in port (RFC 8252 §7.3) and
 * must carry no userinfo, query, or fragment.
 */
export function validateRedirectUri(client: OAuthClient, redirectUri: string): boolean {
  if (!redirectUri) return false;
  if (client.redirectSchemes.includes(redirectUri)) return true;
  if (!client.allowLoopback) return false;
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  // Reject ANY userinfo, including the empty-but-present form "http://:@127.0.0.1"
  // (which parses to empty username/password) — RFC 8252 §7.3 forbids userinfo on
  // a loopback redirect, and matching on the raw string avoids a parser differential.
  if (u.username || u.password || redirectUri.includes("@")) return false;
  if (u.search || u.hash) return false;
  const host = u.hostname; // WHATWG URL keeps IPv6 bracketed → "[::1]"
  if (host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") return false;
  return u.pathname === client.loopbackPath;
}

// === PKCE (S256 only) ===

/** A valid S256 challenge is base64url of a SHA-256 digest → 43 unpadded chars. */
export function isValidCodeChallenge(challenge: string | null | undefined): boolean {
  return typeof challenge === "string" && /^[A-Za-z0-9\-_]{43}$/.test(challenge);
}

/**
 * PKCE S256 verification: base64url(SHA-256(code_verifier)) must equal the stored
 * challenge. The verifier must be a 43–128 char unreserved string (RFC 7636 §4.1).
 * Timing-safe compare so a mismatch leaks nothing.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier || "")) return false;
  const computed = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return safeCompare(computed, codeChallenge);
}

// === Rate limiting (in-memory, per-process) ===
// Mirrors the admin-login limiter: fixed window, bounded bucket count, evict
// expired-then-oldest. `check` counts every call and returns false once over the
// limit for the current window.
export function makeRateLimiter(max: number, windowMs: number, maxBuckets = 1000) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function evict(now: number) {
    if (buckets.size < maxBuckets) return;
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    while (buckets.size >= maxBuckets) {
      const k = buckets.keys().next().value;
      if (!k) break;
      buckets.delete(k);
    }
  }

  return {
    /** @returns true if the request is allowed, false if it should be 429'd. */
    check(key: string, now: number): boolean {
      const b = buckets.get(key);
      if (!b || now >= b.resetAt) {
        evict(now);
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      b.count++;
      return b.count <= max;
    },
  };
}

// === Request body size guard ===
// OAuth bodies are a handful of short form fields; anything large is abuse. We
// reject on the declared Content-Length BEFORE buffering/parsing so a big
// payload can't exhaust memory. (A body with no Content-Length can't be
// pre-checked here; the endpoints are rate-limited as a backstop.)
export const MAX_OAUTH_BODY_BYTES = 8192;

export function bodyTooLarge(
  req: { headers: { get(name: string): string | null } },
  max = MAX_OAUTH_BODY_BYTES
): boolean {
  const len = req.headers.get("content-length");
  if (!len) return false;
  const n = Number(len);
  return Number.isFinite(n) && n > max;
}

// === HTML escaping for the server-rendered consent page ===
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
