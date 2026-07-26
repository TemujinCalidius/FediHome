import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin, safeCompare, sessionIdFromCookie } from "@/lib/auth";
import {
  getPasswordHash,
  verifyPassword,
  setPassword,
  validatePassword,
  hasPassword,
} from "@/lib/password";

/**
 * Set or change the admin password (#356).
 *
 * Cookie-only (`verifyAdmin`, no bearer path), like the other credential
 * routes: an app token must never be able to change the owner's password.
 *
 * The thing worth noticing is what this does NOT do — it never touches
 * `ADMIN_SECRET`. Before the split, "changing your password" meant rotating the
 * key that encrypts every stored credential, so it silently destroyed your
 * Bluesky password, Threads token, analytics key and push keys (#359). Now the
 * password is its own scrypt-hashed value and rotating it costs nothing.
 */

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Never returns the hash — only whether a real password exists yet.
  return NextResponse.json({ hasPassword: await hasPassword() });
}

export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const current = body?.currentPassword;
  const next = body?.newPassword;

  const invalid = validatePassword(next);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  // Re-authenticate before changing it. A valid session alone isn't enough —
  // an unattended browser shouldn't be able to lock the owner out.
  const storedHash = await getPasswordHash();
  const currentOk = storedHash
    ? typeof current === "string" && (await verifyPassword(current, storedHash))
    : // No password set yet: the current credential IS the admin secret, which
      // is exactly the migration case this flow exists to end.
      typeof current === "string" &&
      !!process.env.ADMIN_SECRET &&
      safeCompare(current, process.env.ADMIN_SECRET);

  if (!currentOk) {
    return NextResponse.json(
      { error: storedHash ? "Current password is incorrect." : "Current admin secret is incorrect." },
      { status: 401 },
    );
  }

  await setPassword(next);

  // Sign out everywhere else. Changing a password is the standard way to evict
  // someone who shouldn't still be signed in, so leaving other sessions alive
  // would defeat the point. The current session survives, or the owner would
  // log themselves out by changing it.
  const currentSessionId = sessionIdFromCookie(req.cookies.get("sl_admin")?.value);
  const revoked = await prisma.adminSession
    .deleteMany({ where: currentSessionId ? { id: { not: currentSessionId } } : {} })
    .catch(() => ({ count: 0 }));

  return NextResponse.json({ success: true, otherSessionsRevoked: revoked.count });
}
