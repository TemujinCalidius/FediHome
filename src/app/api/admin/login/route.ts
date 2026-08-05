import { NextRequest, NextResponse } from "next/server";
import { safeCompare, createAdminSession } from "@/lib/auth";
import { getPasswordHash, verifyPassword } from "@/lib/password";
import { rateLimitKey } from "@/lib/client-ip";
import {
  clearLoginAttempts,
  loginBlockedBy,
  recordLoginFailure,
  warnIfSharedBucket,
} from "@/lib/login-throttle";

export async function POST(req: NextRequest) {
  const key = rateLimitKey(req);
  const now = Date.now();

  // The counters used to live here as a private Map keyed on the bare client
  // key (#531). That made one caller's failures everybody's whenever no trusted
  // proxy header is configured — and on the login route "everybody" includes the
  // only person who is supposed to get in. login-throttle.ts owns the whole
  // question now, and is the single implementation of it on purpose.
  warnIfSharedBucket(key);
  if (loginBlockedBy(key, now)) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429 }
    );
  }

  let password: unknown;
  try {
    ({ password } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (typeof password !== "string") {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  // A stored password wins when one exists. Otherwise fall back to comparing
  // ADMIN_SECRET, which is how every install worked before #356 and how they
  // keep working after upgrading without the operator doing anything.
  //
  // The fallback is what makes the migration seamless: log in with the secret
  // exactly as before, then set a real password from the admin panel. Once set,
  // the secret is no longer a password at all — it goes back to being purely the
  // key material it was always meant to be, and can stay untouched forever.
  const storedHash = await getPasswordHash();
  const ok = storedHash
    ? await verifyPassword(password, storedHash)
    : !!process.env.ADMIN_SECRET && safeCompare(password, process.env.ADMIN_SECRET);

  if (!ok) {
    // Counted HERE and nowhere earlier: a real password, examined and wrong.
    // The malformed-body and non-string-password returns above never reach this,
    // so an attacker can't spend the budget with empty POSTs that cost nothing.
    recordLoginFailure(key, now);
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  clearLoginAttempts(key);

  // H4: per-login random session token bound by HMAC(ADMIN_SECRET, sessionId).
  // The session is also persisted (AdminSession) so it can be revoked (#14).
  const { cookieValue, maxAgeSeconds } = await createAdminSession(
    req.headers.get("user-agent")
  );

  // Surface the migration state so the UI can prompt for a real password once,
  // rather than leaving the owner logging in with a 64-char hex string forever.
  const response = NextResponse.json({ success: true, needsPassword: !storedHash });
  response.cookies.set("sl_admin", cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: maxAgeSeconds,
    path: "/",
  });

  return response;
}
