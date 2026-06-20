import { NextRequest, NextResponse } from "next/server";
import { pollBlueskyDMs } from "@/lib/bluesky-dm-poll";
import { verifyAdmin } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await pollBlueskyDMs();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("Bluesky DMs poll failed:", err);
    return NextResponse.json({ error: "Bluesky DMs poll failed" }, { status: 500 });
  }
}
