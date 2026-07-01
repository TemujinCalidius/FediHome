import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";

/**
 * Connected-apps management (#158). Lets the owner revoke the bearer tokens that
 * apps hold — OAuth app tokens and hand-issued Micropub tokens alike.
 *
 *   { action: "revoke", id }  — delete one AuthToken (id = its cuid)
 *   { action: "revoke-all" }  — delete every AuthToken
 *
 * Deleting a row invalidates that bearer on its next request (verifyMicropubToken
 * no longer finds it). Guarded by both CSRF origin and admin auth.
 */
export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  if (action === "revoke") {
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id || id.length > 64) {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }
    // deleteMany (not delete) so a stale/already-revoked id is a no-op, not a throw.
    const result = await prisma.authToken.deleteMany({ where: { id } });
    return NextResponse.json({ success: true, revoked: result.count });
  }

  if (action === "revoke-all") {
    const result = await prisma.authToken.deleteMany({});
    return NextResponse.json({ success: true, revoked: result.count });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
