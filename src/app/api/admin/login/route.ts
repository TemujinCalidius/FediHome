import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { safeCompare } from "@/lib/auth";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;
const MAX_BUCKETS = 1000;

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

/**
 * Resolve the client IP for rate limiting.
 *
 * X-Forwarded-For is attacker-controlled unless a trusted reverse proxy
 * overwrites it. Honor it only when TRUSTED_PROXY=true is explicitly set.
 * Otherwise all requests share a single bucket — that's stricter, not laxer:
 * an attacker still can't rotate buckets to defeat the rate limit (H2).
 */
function getRateLimitKey(req: NextRequest): string {
  if (process.env.TRUSTED_PROXY === "true") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim() || "default";
  }
  return "default";
}

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
  const key = getRateLimitKey(req);
  const now = Date.now();
  const attempts = loginAttempts.get(key);

  if (attempts && attempts.count >= MAX_ATTEMPTS && now < attempts.resetAt) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429 }
    );
  }

  const { password } = await req.json();

  if (!safeCompare(password, process.env.ADMIN_SECRET || "")) {
    if (!attempts || now >= attempts.resetAt) {
      evictIfNeeded(now);
      loginAttempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      attempts.count++;
    }
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  loginAttempts.delete(key);

  // H4: per-login random session token. Cookie value is no longer
  // sha256(ADMIN_SECRET) — every login produces a unique HMAC-bound token.
  const sessionId = crypto.randomBytes(16).toString("hex");
  const mac = crypto
    .createHmac("sha256", process.env.ADMIN_SECRET || "")
    .update(sessionId)
    .digest("hex");
  const cookieValue = `${sessionId}.${mac}`;

  const response = NextResponse.json({ success: true });
  response.cookies.set("sl_admin", cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });

  return response;
}
