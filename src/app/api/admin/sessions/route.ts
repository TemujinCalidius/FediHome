import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin, sessionIdFromCookie } from "@/lib/auth";

/**
 * Admin session management (#14).
 *
 *   { action: "revoke", id }    — delete one session (id = 32-hex session id)
 *   { action: "revoke-others" } — delete every session except the caller's own
 *
 * Deleting a row invalidates that cookie on its next request (verifyAdmin no
 * longer finds the session). Guarded by both CSRF origin and admin auth.
 */
export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const currentId = sessionIdFromCookie(req.cookies.get("sl_admin")?.value);
  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  if (action === "revoke") {
    const id = typeof body?.id === "string" ? body.id : "";
    if (!/^[a-f0-9]{32}$/i.test(id)) {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }
    await prisma.adminSession.delete({ where: { id } }).catch(() => {});
    // Revoking your own current session is a self-logout — signal the client so
    // it can also clear the cookie and bounce to the login screen.
    return NextResponse.json({ success: true, self: id === currentId });
  }

  if (action === "revoke-others") {
    if (!currentId) {
      return NextResponse.json({ error: "no active session" }, { status: 400 });
    }
    const result = await prisma.adminSession.deleteMany({
      where: { id: { not: currentId } },
    });
    return NextResponse.json({ success: true, revoked: result.count });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
