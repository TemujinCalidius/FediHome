import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { lastUpdateCheckAt, startUpdateCheck } from "@/lib/update-check";

export const maxDuration = 60;

/**
 * "Check now" — run the update check on demand (#399).
 *
 * This endpoint existed with no caller anywhere in the tree, and neither did any
 * scheduled run, so nothing ever produced the maintenance items the notification
 * bell renders. It now backs a button in Instance settings, alongside the daily
 * job.
 *
 * Three things were missing, none of which shows up until it bites:
 *
 *  - **no `verifyOrigin`**: a session cookie is sent on cross-site requests too,
 *    so `verifyAdmin` alone didn't make this same-origin. Spawning a process is
 *    not something another site gets to trigger.
 *  - **no in-flight guard**: N rapid POSTs spawned N processes, each opening its
 *    own Prisma pool and its own run of GitHub calls.
 *  - **no 'error' handler on the child**: `spawn` reports a missing executable
 *    through an asynchronous `error` event, and an unhandled one on an
 *    EventEmitter takes the process down — so an install without `npx` on PATH
 *    would have been crashed by its own update check.
 *
 * All three now live in `src/lib/update-check.ts`, shared with the scheduler.
 */
export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // force: the owner pressed the button, so the daily interval doesn't apply.
  // The in-flight guard still does.
  const r = await startUpdateCheck({ force: true });

  if (!r.started) {
    return NextResponse.json(
      {
        started: false,
        reason: r.reason,
        error:
          r.reason === "in-flight"
            ? "A check is already running."
            : "Couldn't start the check — see the server log.",
      },
      // 409, not 500: already running is a perfectly fine state, just not a new run.
      { status: r.reason === "in-flight" ? 409 : 500 },
    );
  }

  return NextResponse.json({ started: true });
}

/** When the last check ran, so the settings screen can say so rather than guess. */
export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const at = await lastUpdateCheckAt();
  return NextResponse.json({
    lastCheckedAt: at && at > 0 ? new Date(at).toISOString() : null,
  });
}
