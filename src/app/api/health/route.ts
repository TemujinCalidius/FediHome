import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sweepExpiredAuthTokens } from "@/lib/auth";
import { log } from "@/lib/log";
import pkg from "@/../package.json";

// Never cache — a health probe must reflect live state.
export const dynamic = "force-dynamic";

/**
 * Lightweight health/monitoring endpoint (#17). Public, read-only, no secrets —
 * intended for uptime monitors and `npm run update` smoke checks. Reports the
 * app version and a live DB round-trip; 200 when healthy, 503 when the DB is
 * unreachable so a monitor can alert.
 */
export async function GET() {
  let db: "ok" | "error" = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    db = "error";
    log.error("health check: database round-trip failed", { err });
  }

  const healthy = db === "ok";

  // Piggyback token hygiene on the regularly-polled health check (throttled to
  // once / 5 min internally; only deletes already-expired tokens). Fire-and-forget.
  if (healthy) void sweepExpiredAuthTokens();

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      version: pkg.version,
      db,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
}
