import { NextRequest, NextResponse } from "next/server";
import { pollBlueskyDMs } from "@/lib/bluesky-dm-poll";

export async function GET(req: NextRequest) {
  const cookie = req.cookies.get("sl_admin")?.value;
  if (cookie !== process.env.ADMIN_SECRET) {
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
