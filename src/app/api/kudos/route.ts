import { NextRequest, NextResponse } from "next/server";
import { createKudos, getKudosForPath } from "@/lib/tinylytics";
import { verifyOrigin } from "@/lib/auth";

// Rate limit: 1 kudos per IP per path per hour
const kudosLog = new Map<string, number>();

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
  if (lastKudos && Date.now() - lastKudos < 3600000) {
    return NextResponse.json({ error: "already sent" }, { status: 429 });
  }

  const success = await createKudos(path);
  if (success) {
    kudosLog.set(key, Date.now());
    return NextResponse.json({ success: true });
  }
  return NextResponse.json({ error: "failed" }, { status: 500 });
}
