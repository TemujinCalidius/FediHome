import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { safeCompare } from "@/lib/auth";

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000; // 1 minute

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const now = Date.now();
  const attempts = loginAttempts.get(ip);

  if (attempts && attempts.count >= MAX_ATTEMPTS && now < attempts.resetAt) {
    return NextResponse.json({ error: "Too many login attempts. Try again later." }, { status: 429 });
  }

  const { password } = await req.json();

  if (!safeCompare(password, process.env.ADMIN_SECRET || "")) {
    // Increment failed attempts
    if (!attempts || now >= (attempts.resetAt || 0)) {
      loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      attempts.count++;
    }
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  // Successful login — clear attempts
  loginAttempts.delete(ip);

  const hashedPassword = crypto.createHash("sha256").update(password).digest("hex");

  const response = NextResponse.json({ success: true });
  response.cookies.set("sl_admin", hashedPassword, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });

  return response;
}
