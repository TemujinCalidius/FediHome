import { spawn } from "node:child_process";
import path from "node:path";
import { prisma } from "./db";

/**
 * Running the update check — on a schedule, and on demand (#399).
 *
 * `scripts/check-updates.ts` has existed since early on and `/api/maintenance/check`
 * could start it, but **nothing ever called either**. So an instance only learned
 * about a security advisory or a new FediHome release if its owner happened to run
 * `npm run check-updates` by hand, which no documentation asks them to do. The
 * notification bell was wired to a source that never produced anything.
 *
 * The check runs as a **child process**, not in-process. It shells out to
 * `npm outdated` and `npm audit`, which block for seconds; doing that inside the
 * Next server would stall every request and wedge the scheduler's master loop.
 */

/** When the check last completed, as an ISO string. */
export const LAST_CHECK_KEY = "maintenance.lastCheckAt";

/**
 * How long a spawned check is assumed to still be running.
 *
 * A lease rather than a flag cleared on exit, because the child is detached and
 * `stdio: "ignore"` — if the parent misses the exit event (or is replaced by a
 * restart), a plain boolean would wedge the check off forever. Generous: the
 * script makes several GitHub calls with 10s timeouts plus two npm invocations.
 */
const LEASE_MS = 10 * 60_000;

/**
 * The in-flight lease lives on `globalThis`, not in a module-level variable.
 *
 * `instrumentation.ts` reaches the scheduler through a **dynamic** import while
 * the API route imports this module **statically**, and those resolve to separate
 * module instances. A plain `let` would be written by the scheduler's copy and
 * read as undefined by the route's — so the manual button and the scheduled run
 * would each think they were the only one, and two checks would spawn at once.
 * Same reason `__fedihomeSchedulerStarted` lives there.
 */
const g = globalThis as typeof globalThis & { __fedihomeUpdateCheckStartedAt?: number };

export type StartOutcome =
  | { started: true }
  | { started: false; reason: "in-flight" | "not-due" | "spawn-failed" };

/** When the last completed check was, in epoch ms — or null if we can't tell. */
export async function lastUpdateCheckAt(): Promise<number | null> {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: LAST_CHECK_KEY } });
    if (!row) return 0; // never checked — genuinely due
    const t = Date.parse(row.value);
    return Number.isFinite(t) ? t : 0;
  } catch {
    // The database is unreachable or mid-migration. Not the same as "never
    // checked": answering 0 there would spawn a check on every boot of a broken
    // instance, against a rate-limited API.
    return null;
  }
}

/** Record that a check has been started, so a restart doesn't re-run it. */
async function markChecked(at: Date): Promise<void> {
  const value = at.toISOString();
  await prisma.siteSetting.upsert({
    where: { key: LAST_CHECK_KEY },
    update: { value },
    create: { key: LAST_CHECK_KEY, value },
  });
}

/**
 * Start the update check, unless it is already running or isn't due yet.
 *
 * `force` skips the due test — that's the admin panel's "Check now" — but never
 * the in-flight test, because N rapid clicks otherwise spawn N processes, each
 * opening its own Prisma pool and its own set of GitHub calls.
 *
 * The watermark is written **before** the child runs, not after. A check that
 * crashes half way should not be retried on a fifteen-second loop; a day later is
 * soon enough, and the alternative risks hammering an unauthenticated GitHub API
 * that allows 60 requests an hour per IP.
 */
export async function startUpdateCheck(
  opts: { force?: boolean; intervalSec?: number } = {},
): Promise<StartOutcome> {
  const now = Date.now();

  const startedAt = g.__fedihomeUpdateCheckStartedAt;
  if (typeof startedAt === "number" && now - startedAt < LEASE_MS) {
    return { started: false, reason: "in-flight" };
  }

  if (!opts.force) {
    const last = await lastUpdateCheckAt();
    if (last === null) return { started: false, reason: "not-due" };
    const intervalMs = (opts.intervalSec ?? 86_400) * 1000;
    if (now - last < intervalMs) return { started: false, reason: "not-due" };
  }

  g.__fedihomeUpdateCheckStartedAt = now;

  try {
    await markChecked(new Date(now));
  } catch (err) {
    // Losing the watermark means the next boot checks again — annoying, not
    // harmful. Don't let it stop the check the owner actually asked for.
    console.error("[fedihome] couldn't record the update-check timestamp:", err);
  }

  const scriptPath = path.join(process.cwd(), "scripts", "check-updates.ts");
  try {
    const child = spawn("npx", ["tsx", scriptPath], {
      cwd: process.cwd(),
      detached: true,
      // The child's own report ("5 package update(s) recorded") is the only
      // evidence the check ran at all — "ignore" discarded it, which is half of
      // why a dead check was unobservable (#437). Inherited rather than piped:
      // the parent is unref'd and must not hold a buffer for a detached child.
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    // `spawn` reports a missing executable through an ASYNCHRONOUS 'error' event.
    // Without a listener that is an unhandled 'error' on an EventEmitter, which
    // takes the whole server process down — so an install without `npx` on PATH
    // would have been crashed by its own update check.
    child.on("error", (err) => {
      console.error("[fedihome] couldn't start the update check:", err);
      g.__fedihomeUpdateCheckStartedAt = undefined;
    });
    child.on("exit", (code, signal) => {
      // The other half of #437. The code was dropped, so a check that genuinely
      // died — a missing schema, a bad DATABASE_URL, an npm failure — was
      // indistinguishable from one that succeeded and found nothing. The lease
      // cleared either way and the next run behaved as if all was well.
      if (code !== 0) {
        console.error(
          `[fedihome] the update check failed (exit ${code ?? "null"}${signal ? `, signal ${signal}` : ""}). ` +
            `Package and security alerts will be stale until it succeeds. ` +
            `Run it directly to see why: npx tsx scripts/check-updates.ts`,
        );
      }
      g.__fedihomeUpdateCheckStartedAt = undefined;
    });
    child.unref();
    return { started: true };
  } catch (err) {
    console.error("[fedihome] couldn't start the update check:", err);
    g.__fedihomeUpdateCheckStartedAt = undefined;
    return { started: false, reason: "spawn-failed" };
  }
}

/** Test seam: forget any in-flight lease. */
export function resetUpdateCheckLease(): void {
  g.__fedihomeUpdateCheckStartedAt = undefined;
}
