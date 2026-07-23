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
 * If a memorable password is ever introduced, hash it with scrypt/argon2, not
 * this. (CodeQL js/insufficient-password-hash flags the sha256 call — a false
 * positive under this invariant; alert #30 dismissed accordingly.)
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Micropub / OAuth scopes are a space-separated string, e.g. "read create dm". */
export function hasScope(scope: string | undefined, required: string): boolean {
  return (scope ?? "").split(/\s+/).includes(required);
}

export async function verifyMicropubToken(
  authHeader: string | null
): Promise<{ valid: boolean; scope?: string; tokenId?: string; clientId?: string | null; label?: string }> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { valid: false };
  }

  const token = authHeader.slice(7);
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
  const siteUrl = getSiteUrl();
  const expected = new URL(siteUrl);

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

  if (origin) return matches(origin);
  if (referer) return matches(referer);
  return false;
}
