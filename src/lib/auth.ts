import crypto from "crypto";
import { prisma } from "./db";

export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
  } catch {
    return false; // different lengths
  }
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function verifyMicropubToken(
  authHeader: string | null
): Promise<{ valid: boolean; scope?: string }> {
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

  // Update last used
  await prisma.authToken.update({
    where: { id: authToken.id },
    data: { lastUsedAt: new Date() },
  });

  return { valid: true, scope: authToken.scope };
}

export async function generateToken(label: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = hashToken(token);

  await prisma.authToken.create({
    data: { tokenHash: hash, label },
  });

  return token;
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

function adminSessionTtlMs(): number {
  const days = Number(process.env.ADMIN_SESSION_TTL_DAYS);
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
  const ttlMs = adminSessionTtlMs();
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
  const siteUrl = process.env.SITE_URL || "http://localhost:3000";
  const expected = new URL(siteUrl);

  const matches = (urlStr: string): boolean => {
    try {
      const u = new URL(urlStr);
      return u.hostname === expected.hostname && u.protocol === expected.protocol;
    } catch {
      return false;
    }
  };

  if (origin) return matches(origin);
  if (referer) return matches(referer);
  return false;
}
