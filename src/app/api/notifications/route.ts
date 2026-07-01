import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest, verifyOrigin, hasScope } from "@/lib/auth";
import { computeNotifications, type NotificationResult } from "@/lib/notifications";

/**
 * DM notifications carry a sender's name/handle/avatar — private metadata. Strip
 * them (and their unread contribution) for a caller that lacks `dm` scope, so a
 * plain `read` token can't learn who's been messaging the owner. The owner cookie
 * and `dm`-scoped tokens see the full set.
 */
function redactDmNotifications(r: NotificationResult): NotificationResult {
  const items = r.items.filter((it) => it.type !== "dm");
  const dmUnread = r.categoryCounts.dm || 0;
  const categoryCounts = { ...r.categoryCounts };
  delete categoryCounts.dm;
  return { count: Math.max(0, r.count - dmUnread), items, categoryCounts };
}

export async function POST(req: NextRequest) {
  // Mark-all-read WRITES the owner's read-state, so it needs a write-capable
  // scope — a read-only token must not be able to reset the badge. `interact` is
  // what first-party apps carry; the owner cookie satisfies any scope.
  const auth = await authenticateApiRequest(req, "interact");
  if (!auth.ok) {
    return auth.via === "bearer"
      ? NextResponse.json({ error: "insufficient_scope" }, { status: 403 })
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // A cookie is ambient, so the cookie path still needs CSRF; a bearer isn't.
  if (auth.via === "cookie" && !verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
  // Cookie OR a `read`-scoped bearer token. Read-only → no CSRF. When there's no
  // valid auth we return the empty shape (not 401), matching the web client's
  // logged-out behaviour.
  const auth = await authenticateApiRequest(req, "read");
  if (!auth.ok) {
    return NextResponse.json({ count: 0, items: [], categoryCounts: {} });
  }

  const result = await computeNotifications();
  const canSeeDm = auth.via === "cookie" || hasScope(auth.scope, "dm");
  return NextResponse.json(canSeeDm ? result : redactDmNotifications(result));
}
