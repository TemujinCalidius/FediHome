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
  /**
   * How this client came to be trusted, and it is not cosmetic — the consent
   * screen has to say which, because the three mean genuinely different things
   * to the person approving:
   *
   *  - `first-party`  ships in FediHome; the owner is trusting us.
   *  - `registered`   the OWNER added it by hand (#366); nothing about a custom
   *                   scheme proves ownership, so their registration IS the check.
   *  - `indieauth`    the client id is a URL we fetched (#494); the document at
   *                   that URL is what vouches for the redirect, and the URL is
   *                   shown so the owner can judge it themselves.
   */
  kind: "first-party" | "registered" | "indieauth";
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
    kind: "first-party",
    redirectSchemes: ["fedihome-macos://callback"],
    allowLoopback: true,
    loopbackPath: "/callback",
  },
  {
    id: "fedihome-ios",
    label: "FediHome for iOS",
    kind: "first-party",
    redirectSchemes: ["fedihome-ios://callback"],
    allowLoopback: true,
    loopbackPath: "/callback",
  },
  {
    id: "fedihome-android",
    label: "FediHome for Android",
    kind: "first-party",
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
/**
 * Schemes a redirect URI may use (#366).
 *
 * THE REASON THIS EXISTS. authorize/route.ts renders the redirect target as
 * `href="${escapeHtml(target)}"` and then calls `location.replace(a.href)`.
 * escapeHtml does nothing to a dangerous SCHEME, so `javascript:...` in a
 * redirect URI is script execution in the owner's authenticated session.
 *
 * Harmless while every client was hardcoded with an exact-match URI. The moment
 * a registration can supply one it is the sharpest edge in the feature, which is
 * why the check lives HERE — on the path every client goes through — rather than
 * in the admin handler alone. A hand-edited database row has to fail too. That
 * is the #431 lesson: validate wherever the value comes from.
 *
 * `http:` is allowed only for loopback, which the caller enforces separately.
 */
const SAFE_SCHEME = /^[a-z][a-z0-9+.-]*:/;
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:"]);

export function isSafeRedirectScheme(redirectUri: string): boolean {
  const m = redirectUri.toLowerCase().match(SAFE_SCHEME);
  if (!m) return false;
  return !FORBIDDEN_SCHEMES.has(m[0]);
}

/**
 * Same origin as the client id, compared by parsed origin rather than by string
 * prefix (#494).
 *
 * A prefix test is the bug here, not a shortcut: `https://quill.p3k.io` is a
 * prefix of `https://quill.p3k.io.evil.example`, so prefix-matching a redirect
 * against a client id hands the code to whoever owns the longer domain.
 */
function sameRedirectOrigin(clientId: string, redirectUri: string): boolean {
  try {
    return new URL(clientId).origin === new URL(redirectUri).origin;
  } catch {
    return false;
  }
}

export function validateRedirectUri(client: OAuthClient, redirectUri: string): boolean {
  if (!redirectUri) return false;
  // Before anything else, including the exact-match fast path — a registration
  // that stored a javascript: URI must not pass by matching itself.
  if (!isSafeRedirectScheme(redirectUri)) return false;
  if (client.redirectSchemes.includes(redirectUri)) return true;

  // The third matching mode (#494): a URL client_id vouches for anything on its
  // OWN origin without having to enumerate it. That is the spec's rule, and it
  // is the whole reason a web client needs no registration — the document at the
  // client id is what proves the redirect belongs to it.
  //
  // Scoped to `kind === "indieauth"` deliberately. Applying it to a registered
  // client would silently widen every registration from "these exact URIs" to
  // "this whole origin", which is more than the owner was asked to assert.
  // Cross-origin redirects still require an exact match against the
  // `rel="redirect_uri"` list, handled by the check above.
  if (client.kind === "indieauth") return sameRedirectOrigin(client.id, redirectUri);

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

    /**
     * Would the next `check` be allowed — without spending anything (#531).
     *
     * The login route can't use `check` for its gate. It has to ask "is this
     * caller blocked?" *before* verifying a password, and count only if the
     * password turns out to be wrong; counting at the gate would let anyone
     * lock the owner out with empty POSTs that cost the server nothing.
     */
    peek(key: string, now: number): boolean {
      const b = buckets.get(key);
      if (!b || now >= b.resetAt) return true;
      return b.count < max;
    },

    /** Forget a key entirely — a successful login clears its own failures. */
    reset(key: string): void {
      buckets.delete(key);
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

// === App-token lifetime (#327) ===

/**
 * Upper bound on a per-token lifetime, mirroring the int cap that
 * `validateSiteConfigValue` already applies to `security.appTokenTtlDays`
 * (site-settings.ts). A token picked on the Apps screen must not be able to
 * outlive what the settings screen itself permits.
 */
export const MAX_APP_TOKEN_TTL_DAYS = 3650;

/**
 * Turn a day count into an expiry. `0` (or anything non-positive) means the
 * token never expires — long-lived and revocable, which is what every token
 * issued before this existed already is.
 *
 * Lives HERE, not next to `generateToken` in auth.ts where it conceptually
 * belongs, for a concrete reason: `apps-create-token.test.ts` replaces the whole
 * of `@/lib/auth` with three functions, so an import added there resolves to
 * `undefined` at runtime and takes the suite with it. This module is already the
 * shared app-token vocabulary both mint sites import (`sanitizeScope`) and is
 * mocked by neither.
 *
 * `now` is injected so a test can assert the arithmetic rather than a window.
 */
export function appTokenExpiry(days: number, now: number = Date.now()): Date | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now + days * 24 * 60 * 60 * 1000);
}

/** A day count a client is allowed to ask for. `0` is valid and means "never". */
export function isValidTtlDays(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_APP_TOKEN_TTL_DAYS;
}
