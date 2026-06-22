import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin } from "@/lib/auth";
import { computeNotifications } from "@/lib/notifications";

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Mark all as read — store timestamp in DB so it syncs across devices
  await prisma.siteSetting.upsert({
    where: { key: "notif_read_at" },
    update: { value: new Date().toISOString() },
    create: { key: "notif_read_at", value: new Date().toISOString() },
  });

  return NextResponse.json({ success: true });
}

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ count: 0, items: [], categoryCounts: {} });
  }

  return NextResponse.json(await computeNotifications());
}
