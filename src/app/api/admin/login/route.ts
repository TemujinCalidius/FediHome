import { NextRequest, NextResponse } from "next/server";
import { safeCompare, createAdminSession } from "@/lib/auth";
import { getPasswordHash, verifyPassword } from "@/lib/password";
import { rateLimitKey } from "@/lib/client-ip";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;
const MAX_BUCKETS = 1000;

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function evictIfNeeded(now: number) {
  if (loginAttempts.size < MAX_BUCKETS) return;
  // First sweep expired entries.
  for (const [k, v] of loginAttempts) {
    if (v.resetAt < now) loginAttempts.delete(k);
  }
  // Still full → evict oldest insertion (Map preserves insertion order).
  while (loginAttempts.size >= MAX_BUCKETS) {
    const k = loginAttempts.keys().next().value;
    if (!k) break;
    loginAttempts.delete(k);
  }
}

export async function POST(req: NextRequest) {
  const key = rateLimitKey(req);
  const now = Date.now();
  const attempts = loginAttempts.get(key);

  if (attempts && attempts.count >= MAX_ATTEMPTS && now < attempts.resetAt) {
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
    if (!attempts || now >= attempts.resetAt) {
      evictIfNeeded(now);
      loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      attempts.count++;
    }
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  loginAttempts.delete(key);

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
