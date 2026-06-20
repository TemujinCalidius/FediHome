import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { sendPushToOwner, pushConfigured } from "@/lib/push";
import { siteConfig } from "@/../site.config";

/** Fire a test push to all of the owner's devices so a new install can be verified. */
export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  if (!pushConfigured()) {
    return NextResponse.json({ error: "push not configured" }, { status: 503 });
  }

  await sendPushToOwner({
    title: "Notifications are on 🎉",
    body: `This is a test push from ${siteConfig.name}.`,
    url: "/timeline",
    type: "test",
    tag: "test",
  });

  return NextResponse.json({ ok: true });
}
