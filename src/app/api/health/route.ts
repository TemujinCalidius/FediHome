import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { sweepExpiredAuthTokens } from "@/lib/auth";
import { pruneTokenUsage } from "@/lib/audit";
import { log } from "@/lib/log";
import pkg from "@/../package.json";
import { shortSha } from "@/lib/build-info";
import { schedulerLastTickAgoMs, schedulerStarted, SCHEDULER_TICK_MS } from "@/lib/scheduler";
import { worstStorageStatus } from "@/lib/storage-usage";

// Never cache — a health probe must reflect live state.
export const dynamic = "force-dynamic";

/**
 * Lightweight health/monitoring endpoint (#17). Public, read-only, no secrets —
 * intended for uptime monitors, the Docker HEALTHCHECK, and `npm run update`
 * smoke checks. 200 when healthy, 503 when not, so a monitor can alert.
 *
 * Beyond the DB round-trip it answers three questions the version alone can't
 * (#358):
 *  - WHICH build is this? `version` is the same for every commit between two
 *    releases, so bug reports were ambiguous. `build` is the actual commit.
 *  - Has it just restarted? `uptimeSeconds` distinguishes "healthy" from
 *    "healthy because it restarted for the fifth time".
 *  - Is the scheduler alive? It runs IN-PROCESS, so it can wedge while HTTP
 *    keeps returning 200 — an instance that looks fine while silently no longer
 *    publishing scheduled posts. A stale tick is reported as degraded.
 *  - Is the disk filling? (#385) A full uploads volume fails every upload, and
 *    the first symptom is usually a failed post.
 *
 * `storage` is a STATUS, not a byte count. This endpoint is public and
 * unauthenticated, and how big your disk is and how full it is are nobody
 * else's business — the same reason `db` reports "ok"/"error" rather than a
 * connection string. Exact figures, and the split between your own media and
 * cached remote media, are in Admin → Site settings → Storage.
 *
 * It also deliberately does NOT affect `status`. The Docker HEALTHCHECK restarts
 * a degraded container, and restarting does not free disk space — it would just
 * crash-loop. Report it; let a monitor decide.
 */
export async function GET() {
  let db: "ok" | "error" = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    db = "error";
    log.error("health check: database round-trip failed", { err });
  }

  // Generous multiple of the tick interval: a single slow pass (a big Bluesky
  // sync, a slow remote) must not flap the health state. Only a genuinely
  // stopped loop should show.
  const tickAgoMs = schedulerLastTickAgoMs();
  const schedulerStale =
    schedulerStarted() && tickAgoMs !== null && tickAgoMs > SCHEDULER_TICK_MS * 20;

  // One statfs syscall PER UPLOADS ROOT — still cheap enough for a probe polled
  // every 30s, and there are at most two. The usage walk is far too expensive
  // for that and runs in the scheduler instead.
  //
  // Every root, not just the configured one (#586). After a move, the old root
  // still holds everything written before it and is often a separate volume —
  // it can fill completely while a single-root check reports "ok", because it is
  // measuring a different filesystem. Still a STATUS and still no path: this
  // endpoint is public, per the note above.
  const storage = await worstStorageStatus();

  const healthy = db === "ok" && !schedulerStale;

  // Piggyback token hygiene on the regularly-polled health check (throttled to
  // once / 5 min internally; only deletes already-expired tokens). Fire-and-forget.
  if (healthy) {
    void sweepExpiredAuthTokens();
    void pruneTokenUsage();
  }

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      version: pkg.version,
      build: shortSha(),
      db,
      uptimeSeconds: Math.round(process.uptime()),
      storage,
      scheduler: schedulerStarted()
        ? {
            running: !schedulerStale,
            lastTickSecondsAgo: tickAgoMs === null ? null : Math.round(tickAgoMs / 1000),
          }
        : { running: false, lastTickSecondsAgo: null },
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
}
