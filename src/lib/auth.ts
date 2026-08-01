import crypto from "crypto";
import { prisma } from "./db";
import { recordTokenUse } from "./audit";
import { getSiteUrl } from "./identity";

export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
  } catch {
    return false; // different lengths
  }
}

/**
 * SHA-256 lookup hash for HIGH-ENTROPY random secrets ONLY — OAuth
 * authorization codes and bearer/Micropub tokens (≥ 64 hex chars, minted with
 * crypto.randomBytes). A fast hash is the correct (and required) choice here: it
 * gives O(1) DB lookup by `tokenHash` and there's no offline-guessing risk when
 * the input has ~256 bits of entropy. It is NOT a password hash.
 *
 * INVARIANT: never pass a human-chosen/low-entropy secret to this. The owner's
 * `ADMIN_SECRET` is never hashed (it's compared with timingSafeEqual, and is
 * itself a 64–128-hex random value); admin session ids are random + HMAC-bound.
 *
 * A memorable password now EXISTS as of #356 — and it deliberately does not come
 * anywhere near this function. It is scrypt-hashed in `lib/password.ts`, exactly
 * as the earlier version of this comment instructed. So the invariant is intact
 * and CodeQL alert #30 stays a false positive; the condition it anticipated
 * arrived and was handled, rather than quietly violated. Anyone adding a new
 * credential path: if a human chooses it, it belongs in `password.ts`, not here.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Micropub / OAuth scopes are a space-separated string, e.g. "read create dm". */
export function hasScope(scope: string | undefined, required: string): boolean {
  return (scope ?? "").split(/\s+/).includes(required);
}

export interface TokenVerification {
  valid: boolean;
  scope?: string;
  tokenId?: string;
  clientId?: string | null;
  label?: string;
}

/**
 * Verify a raw token value — everything about a token that has nothing to do
 * with how it arrived.
 *
 * Split out from `verifyMicropubToken` because **not every caller gets a Bearer
 * header**. XML-RPC passes the token as a positional parameter (the MetaWeblog
 * `password` slot), and because this logic used to be reachable only through the
 * header parser, `/xmlrpc` grew its own verifier that checked existence and
 * nothing else — no expiry, no scope, no `lastUsedAt`. One transport quirk cost
 * three controls. There is now one place that answers "is this token good?", and
 * transports adapt to it rather than reimplementing it.
 *
 * Returns `scope` so the caller can gate with `hasScope`; this function
 * deliberately makes no authorization decision of its own.
 */
export async function verifyTokenValue(token: string): Promise<TokenVerification> {
  // Fail closed on an empty value: `hashToken("")` is a perfectly valid sha256,
  // so without this a missing password would look up a real row if one ever
  // hashed to it, and would in any case waste a query on every blank request.
  if (!token) {
    return { valid: false };
  }

  const hash = hashToken(token);

  const authToken = await prisma.authToken.findUnique({
    where: { tokenHash: hash },
  });

  if (!authToken) {
    return { valid: false };
  }

  // Reject expired tokens. OAuth app tokens may set `expiresAt`; hand-issued
  // Micropub tokens leave it null (no expiry, revocable via the row).
  if (authToken.expiresAt && authToken.expiresAt.getTime() < Date.now()) {
    return { valid: false };
  }

  // Update last used
  await prisma.authToken.update({
    where: { id: authToken.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    valid: true,
    scope: authToken.scope,
    tokenId: authToken.id,
    clientId: authToken.clientId,
    label: authToken.label,
  };
}

/** `verifyTokenValue` for callers whose token arrives as an `Authorization` header. */
export async function verifyMicropubToken(
  authHeader: string | null
): Promise<TokenVerification> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { valid: false };
  }
  return verifyTokenValue(authHeader.slice(7));
}

export async function generateToken(
  label: string,
  opts?: { scope?: string; clientId?: string | null; createdVia?: string; expiresAt?: Date | null }
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = hashToken(token);

  await prisma.authToken.create({
    data: {
      tokenHash: hash,
      label,
      ...(opts?.scope ? { scope: opts.scope } : {}),
      clientId: opts?.clientId ?? null,
      createdVia: opts?.createdVia ?? "micropub",
      expiresAt: opts?.expiresAt ?? null,
    },
  });

  return token;
}

let lastTokenSweep = 0;

/**
 * Delete expired app tokens (a past `expiresAt`). Best-effort table hygiene —
 * expired tokens are already rejected by `verifyMicropubToken`, so this just
 * keeps the row count bounded. Non-expiring rows (null `expiresAt`) are left
 * untouched. Throttled to once / 5 min per process so it's cheap to call from a
 * frequently-polled path (the health check); pass `force` to bypass the throttle.
 */
export async function sweepExpiredAuthTokens(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastTokenSweep < 5 * 60 * 1000) return 0;
  lastTokenSweep = now;
  try {
    const res = await prisma.authToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return res.count;
  } catch {
    return 0;
  }
}

export interface ApiAuth {
  ok: boolean;
  via: "bearer" | "cookie" | null;
  /** Granted scopes (space-separated) for a bearer token; "*" for the owner cookie. */
  scope: string;
}

/**
 * Unified auth for API routes that should accept EITHER a scoped bearer token
 * (a native app / Micropub client) OR the owner's admin session cookie. Tries
 * the bearer token first (stateless), then falls back to the cookie.
 *
 * SECURITY: a bearer token in the `Authorization` header is not an ambient
 * browser credential, so it needs no CSRF check. A COOKIE-authenticated
 * state-changing request must STILL pass `verifyOrigin()` — the caller is
 * responsible for that when `via === "cookie"`. The owner cookie satisfies any
 * `requiredScope` (the owner has full rights); bearer tokens are gated on scope.
 */
export async function authenticateApiRequest(
  req: {
    headers: { get(name: string): string | null };
    cookies: { get(name: string): { value: string } | undefined };
    method?: string;
    nextUrl?: { pathname: string };
  },
  requiredScope?: string
): Promise<ApiAuth> {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = await verifyMicropubToken(authHeader);
    if (!token.valid) return { ok: false, via: null, scope: "" };
    if (requiredScope && !hasScope(token.scope, requiredScope)) {
      return { ok: false, via: "bearer", scope: token.scope ?? "" };
    }
    // Audit write/action requests (not read polls) — best-effort, non-blocking.
    if (req.method && req.method !== "GET") void recordTokenUse(token, req);
    return { ok: true, via: "bearer", scope: token.scope ?? "" };
  }
  if (await verifyAdmin(req)) {
    return { ok: true, via: "cookie", scope: "*" };
  }
  return { ok: false, via: null, scope: "" };
}

/**
 * Verify the admin session cookie.
 *
 * Format: "<sessionId>.<hmac>" where hmac = HMAC-SHA256(ADMIN_SECRET, sessionId).
 * Each successful login generates a unique sessionId, so the cookie value is
 * no longer a deterministic function of ADMIN_SECRET (H4).
 */
export function verifyAdminCookieValue(cookie: string | undefined): boolean {
  if (!cookie) return false;
  const adminSecret = process.env.ADMIN_SECRET || "";
  if (!adminSecret) return false;
  const dot = cookie.indexOf(".");
  if (dot <= 0 || dot === cookie.length - 1) return false;
  const sessionId = cookie.slice(0, dot);
  const sentMac = cookie.slice(dot + 1);
  if (!/^[a-f0-9]{32}$/i.test(sessionId)) return false;
  if (!/^[a-f0-9]{64}$/i.test(sentMac)) return false;
  const expectedMac = crypto
    .createHmac("sha256", adminSecret)
    .update(sessionId)
    .digest("hex");
  return safeCompare(sentMac, expectedMac);
}

/** Parse the session id (the cookie's first segment) without validating the HMAC. */
export function sessionIdFromCookie(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  if (dot <= 0) return null;
  const id = cookie.slice(0, dot);
  return /^[a-f0-9]{32}$/i.test(id) ? id : null;
}

async function adminSessionTtlMs(): Promise<number> {
  // Web-editable (Admin → Security), env as the default (#59).
  const { getRuntimeSiteConfig } = await import("@/lib/site-settings");
  const days = (await getRuntimeSiteConfig()).security.adminSessionTtlDays;
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
}

/**
 * Mint a new admin session: a random id, its HMAC-bound cookie value, and a
 * persisted `AdminSession` row so the session can later be revoked. Returns the
 * cookie value to set and the maxAge (seconds) to match the row's expiry.
 */
export async function createAdminSession(
  userAgent?: string | null
): Promise<{ cookieValue: string; maxAgeSeconds: number }> {
  const sessionId = crypto.randomBytes(16).toString("hex");
  const mac = crypto
    .createHmac("sha256", process.env.ADMIN_SECRET || "")
    .update(sessionId)
    .digest("hex");
  const ttlMs = await adminSessionTtlMs();
  const expiresAt = new Date(Date.now() + ttlMs);
  // Opportunistically sweep expired rows so the table can't grow unbounded.
  await prisma.adminSession
    .deleteMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { lt: new Date() } }] },
    })
    .catch(() => {});
  await prisma.adminSession.create({
    data: { id: sessionId, expiresAt, userAgent: userAgent?.slice(0, 256) || null },
  });
  return { cookieValue: `${sessionId}.${mac}`, maxAgeSeconds: Math.floor(ttlMs / 1000) };
}

/** Delete the session row for a cookie (used on logout). No-op if absent. */
export async function deleteAdminSession(cookie: string | undefined): Promise<void> {
  const id = sessionIdFromCookie(cookie);
  if (!id) return;
  await prisma.adminSession.delete({ where: { id } }).catch(() => {});
}

/**
 * Authoritative "is this a live admin session?" check.
 *
 * 1. Cheap HMAC gate (`verifyAdminCookieValue`) — rejects absent/forged cookies
 *    with no DB hit, so anonymous traffic never touches the database.
 * 2. DB check — the session row must exist and be unexpired. A revoked (deleted)
 *    or expired row fails here, which is what makes sessions revocable (#14).
 */
export async function verifyAdminSession(cookie: string | undefined): Promise<boolean> {
  if (!verifyAdminCookieValue(cookie)) return false;
  const sessionId = sessionIdFromCookie(cookie);
  if (!sessionId) return false;
  const session = await prisma.adminSession
    .findUnique({ where: { id: sessionId } })
    .catch(() => null);
  if (!session) return false;
  // Fail closed: a missing expiry is treated as expired, so a stray null-expiry
  // row (e.g. a future code path or a manual insert) can never authenticate.
  if (!session.expiresAt || session.expiresAt.getTime() < Date.now()) {
    await prisma.adminSession.delete({ where: { id: sessionId } }).catch(() => {});
    return false;
  }
  // Throttle lastUsedAt writes to at most once/minute — the admin dashboard
  // polls several endpoints, and we don't want a DB write on every request.
  if (Date.now() - session.lastUsedAt.getTime() > 60_000) {
    await prisma.adminSession
      .update({ where: { id: sessionId }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }
  return true;
}

export async function verifyAdmin(req: {
  cookies: { get(name: string): { value: string } | undefined };
}): Promise<boolean> {
  return verifyAdminSession(req.cookies.get("sl_admin")?.value);
}

/** CSRF origin check. Returns true if origin matches site URL (hostname AND protocol). */
export function verifyOrigin(req: { headers: { get(name: string): string | null } }): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  // Fail CLOSED on a malformed SITE_URL rather than throwing. This was outside
  // the try/catch below, so `SITE_URL=example.com` (no scheme) turned every
  // mutation into a 500 with a stack trace instead of a 403.
  let expected: URL;
  try {
    expected = new URL(getSiteUrl());
  } catch {
    return false;
  }

  const matches = (urlStr: string): boolean => {
    try {
      const u = new URL(urlStr);
      // Compare port too: a different port is a distinct origin, so an attacker
      // page on the same host:otherPort must not pass the CSRF check. WHATWG URL
      // normalises the default port away, so "" === "" holds for the common case.
      return (
        u.hostname === expected.hostname &&
        u.protocol === expected.protocol &&
        u.port === expected.port
      );
    } catch {
      return false;
    }
  };

  if (origin) return matches(origin) || reportMismatch(origin, expected);
  if (referer) return matches(referer) || reportMismatch(referer, expected);
  return false;
}

/**
 * Say WHY a CSRF check failed, once per distinct pair (#447).
 *
 * A wrong SITE_URL 403s every mutation in the panel, and the body is a bare
 * `{"error":"forbidden"}` — which reads like a permissions problem, not a typo
 * in a setting. Owners have reported it as broken auth.
 *
 * The log is the right channel rather than the response body, and specifically
 * for the population that gets stuck: a PaaS owner rarely has a persistent
 * shell, but they always have logs. It also keeps the diagnosis out of a reply
 * sent to whoever triggered it.
 *
 * Deduped because a 403'd panel retries, and a line repeated on every click is
 * one an operator learns to scroll past. Always returns false — it reports, it
 * never decides.
 */
const reportedMismatches = new Set<string>();
function reportMismatch(actual: string, expected: URL): false {
  try {
    const seen = `${new URL(actual).origin} ${expected.origin}`;
    if (!reportedMismatches.has(seen)) {
      reportedMismatches.add(seen);
      console.warn(
        `[fedihome] Refused a request from ${new URL(actual).origin} because SITE_URL says this ` +
          `site is ${expected.origin}. If you are browsing the first address, that setting is wrong ` +
          `and every change you make in the panel will be refused until it is corrected. ` +
          `See docs/configuration.md, or scripts/set-identity.ts if the panel already refuses you.`,
      );
    }
  } catch {
    /* unparseable header — nothing useful to say */
  }
  return false;
}

/**
 * Same-origin check for the **only** routes that must work before `getSiteUrl()`
 * can be trusted: the setup wizard (#430) and the identity route that repairs a
 * wrong `SITE_URL` (#426).
 *
 * Everything else uses `verifyOrigin`. There are exactly three call sites and a
 * test asserts it stays that way.
 *
 * **The problem.** `verifyOrigin` compares against the *configured* origin. Set
 * `SITE_URL` to a host you don't serve and every mutation 403s — including the
 * one route that would set it back. On a fresh install it's worse: `getSiteUrl()`
 * is `http://localhost:3000` while the browser's Origin is the real hostname, so
 * adding a CSRF check to setup at all would 403 every Docker and proxy install.
 *
 * **The mechanism.** Compare Origin/Referer against the request's OWN host.
 * `Origin`, `Referer` and `Host` are all forbidden header names, so page
 * JavaScript cannot set any of them; a cross-site page gets `Origin: <its own>`
 * and `Host: <ours>`, which cannot agree.
 *
 * **Where this is WEAKER than `verifyOrigin`, and why that's affordable here.**
 * It asks "is this same-origin?", not "is this to the address I think I am". A
 * hostname an attacker owns, pointed at this server's IP and served by our
 * catch-all vhost, is same-origin to the browser and passes. The shipped nginx
 * has no `default_server` rejection, so that is reachable. It is affordable on
 * these three routes ONLY because each is separately gated by a credential such
 * an origin cannot carry — the admin cookie is scoped to the real hostname, the
 * setup token is out-of-band. **Call the credential check FIRST.** On an
 * unauthenticated route (`/api/comments`, `/api/kudos`) this would be a genuine
 * widening. Do not reuse it there.
 *
 * **Neither `host` nor `x-forwarded-host` is trusted.** Both are client-supplied
 * under the nginx config we ship (`proxy_set_header Host $host`), and Next
 * normalises `x-forwarded-host ??= host`. Soundness comes from Origin/Host
 * AGREEMENT, not from either being authentic. The `TRUSTED_PROXY` gate here is
 * for COMPATIBILITY with proxies that rewrite Host to a backend name — unlike
 * `client-ip.ts`, where the same gate genuinely is the trust boundary.
 */
export function verifySameOriginRequest(req: {
  headers: { get(name: string): string | null };
}): boolean {
  const trustProxy = process.env.TRUSTED_PROXY === "true";
  const rawHost = (
    trustProxy ? (req.headers.get("x-forwarded-host") ?? req.headers.get("host")) : req.headers.get("host")
  )
    ?.split(",")[0]
    .trim()
    .toLowerCase();
  if (!rawHost || !/^[a-z0-9.\-[\]:]+$/.test(rawHost)) return false;

  let self: URL;
  try {
    self = new URL(`http://${rawHost}`); // parses "[::1]:3000" correctly too
  } catch {
    return false;
  }
  if (!self.hostname) return false;

  const fwdProto = trustProxy
    ? req.headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase()
    : undefined;

  const matches = (urlStr: string): boolean => {
    let u: URL;
    try {
      u = new URL(urlStr); // "null", "" and opaque origins all land here
    } catch {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.hostname.toLowerCase() !== self.hostname) return false;
    // nginx's `Host $host` DROPS the port, so only compare it when it survived.
    // The residual looseness costs nothing: cookies ignore port, so a service on
    // another port of this same hostname can already read the admin cookie.
    if (self.port && self.port !== u.port) return false;
    if (fwdProto && `${fwdProto}:` !== u.protocol) return false;
    return true;
  };

  const origin = req.headers.get("origin");
  if (origin) return matches(origin);
  // Referer is a forbidden header too, so it is no more forgeable than Origin.
  // The difference is that a Referrer-Policy can SUPPRESS it — which causes a
  // false 403, never a bypass. Accepting it costs nothing and buys recovery in
  // exactly the misconfigured case this function exists for.
  const referer = req.headers.get("referer");
  if (referer) return matches(referer);
  return false;
}
