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

/** Simple admin check — check for admin token in cookie or Authorization header */
export function isAdminRequest(authHeader: string | null): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  return safeCompare(token, process.env.ADMIN_SECRET || "");
}

/** Verify admin via cookie. Use in API route handlers. */
export function verifyAdmin(req: { cookies: { get(name: string): { value: string } | undefined } }): boolean {
  const cookie = req.cookies.get("sl_admin")?.value;
  if (!cookie) return false;
  const expectedHash = crypto.createHash("sha256").update(process.env.ADMIN_SECRET || "").digest("hex");
  return safeCompare(cookie, expectedHash);
}

/** CSRF origin check. Returns true if origin is allowed. */
export function verifyOrigin(req: { headers: { get(name: string): string | null } }): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const siteUrl = process.env.SITE_URL || "http://localhost:3000";
  const siteDomain = new URL(siteUrl).hostname;

  // Allow if origin matches
  if (origin) {
    try {
      return new URL(origin).hostname === siteDomain;
    } catch {
      return false;
    }
  }

  // Fall back to referer
  if (referer) {
    try {
      return new URL(referer).hostname === siteDomain;
    } catch {
      return false;
    }
  }

  // No origin or referer — could be a same-origin request from some browsers
  // or a direct API call. Allow for GET, block for state-changing methods.
  return false;
}
