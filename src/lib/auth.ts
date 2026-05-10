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

export function verifyAdmin(req: { cookies: { get(name: string): { value: string } | undefined } }): boolean {
  return verifyAdminCookieValue(req.cookies.get("sl_admin")?.value);
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
