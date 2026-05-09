import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin } from "@/lib/auth";
import { parsePeerTubeUrl } from "@/lib/peertube";

export async function POST(req: NextRequest) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const parsed = await parsePeerTubeUrl(url);
  if (!parsed) {
    return NextResponse.json({
      error: "Not a recognized PeerTube URL or host not in allowlist",
    }, { status: 400 });
  }

  return NextResponse.json(parsed);
}
