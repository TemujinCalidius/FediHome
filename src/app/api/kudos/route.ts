import { NextRequest, NextResponse } from "next/server";
import { createKudos, getKudosForPath } from "@/lib/tinylytics";
import { verifyOrigin } from "@/lib/auth";

// Rate limit: 1 kudos per IP per path per hour
const kudosLog = new Map<string, number>();
const KUDOS_TTL = 3600_000; // 1 hour
const KUDOS_MAX = 5_000;

function evictKudosLog() {
  const now = Date.now();
  for (const [key, ts] of kudosLog) {
    if (now - ts > KUDOS_TTL) kudosLog.delete(key);
  }
  // If still over cap after TTL eviction, drop oldest entries
  if (kudosLog.size > KUDOS_MAX) {
    const sorted = [...kudosLog.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of sorted.slice(0, kudosLog.size - KUDOS_MAX)) {
      kudosLog.delete(key);
    }
  }
}

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });

  const { getKudosForPath: getKudos } = await import("@/lib/tinylytics");
  const count = await getKudos(path);
  return NextResponse.json({ count });
}

export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { path } = await req.json();
  if (!path || typeof path !== "string") {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  // Simple rate limit
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const key = `${ip}:${path}`;
  const lastKudos = kudosLog.get(key);
  if (lastKudos && Date.now() - lastKudos < KUDOS_TTL) {
    return NextResponse.json({ error: "already sent" }, { status: 429 });
  }

  const success = await createKudos(path);
  if (success) {
    evictKudosLog();
    kudosLog.set(key, Date.now());
    return NextResponse.json({ success: true });
  }
  return NextResponse.json({ error: "failed" }, { status: 500 });
}
