import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";

/**
 * My relationship with one actor — "am I following them, have I blocked them".
 *
 * Exists so the actor-actions popup can offer the RIGHT action instead of
 * showing Follow and Unfollow side by side and hoping. `/api/graph` already
 * carries this information, but it returns the entire social graph, which is a
 * lot to transfer to answer a question about a single person.
 *
 * Cookie OR a `read`-scoped bearer token, matching /api/graph. Read-only, so no
 * CSRF check. Both lookups are on `@unique` columns.
 */
export async function GET(req: NextRequest) {
  if (!(await authenticateApiRequest(req, "read")).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const actorUri = req.nextUrl.searchParams.get("actorUri")?.trim();
  if (!actorUri) {
    return NextResponse.json({ error: "actorUri required" }, { status: 400 });
  }

  const [following, blocked] = await Promise.all([
    prisma.fediFollowing.findUnique({ where: { actorUri }, select: { id: true } }),
    prisma.blockedActor.findUnique({ where: { actorUri }, select: { id: true } }),
  ]);

  return NextResponse.json({ following: !!following, blocked: !!blocked });
}
