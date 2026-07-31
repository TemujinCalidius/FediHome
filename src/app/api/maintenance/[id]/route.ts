import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Origin first, as everywhere else: a session cookie is sent on cross-site
  // requests too, so admin alone doesn't make a mutation same-origin.
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const data: { applied?: boolean; dismissed?: boolean } = {};
  if (typeof body.applied === "boolean") data.applied = body.applied;
  if (typeof body.dismissed === "boolean") data.dismissed = body.dismissed;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  try {
    await prisma.maintenanceItem.update({ where: { id }, data });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
