import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin } from "@/lib/auth";

/**
 * Recent connected-app activity (#158) — the audit trail written by
 * `recordTokenUse`. Owner-only (cookie), read-only (GET → no CSRF).
 */
export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limitRaw = Number(req.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 100;

  const rows = await prisma.appTokenUsage.findMany({ orderBy: { at: "desc" }, take: limit });

  return NextResponse.json({
    events: rows.map((r) => ({
      id: r.id,
      label: r.label,
      clientId: r.clientId,
      scope: r.scope,
      method: r.method,
      path: r.path,
      at: r.at.toISOString(),
    })),
  });
}
