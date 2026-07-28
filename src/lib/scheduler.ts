import { getSchedulerConfig, getEffectiveSchedulerConfig } from "./scheduler-config";
import { publishDueScheduledPosts } from "./publish-post";
import { syncBlueskyGraph } from "./bluesky-graph";
import { pollBlueskyDMs } from "./bluesky-dm-poll";
import { syncBlueskyNotifications } from "./bluesky-notifications";
import { retryFailedDeliveries } from "./delivery-retry";
import { retryFailedCrossposts } from "./crosspost-retry";
import { pruneStaleFediPosts } from "./fedi-retention";

/**
 * FediHome's periodic jobs (publishing due scheduled posts #183, Bluesky sync),
 * run INSIDE the Next server process — started once from src/instrumentation.ts
 * when the server boots. No separate worker, cron, or PM2 entry: anyone who
 * runs FediHome (`npm start`, PM2, Docker) gets the scheduler automatically.
 *
 * Why in-process (and not a tsx script): a standalone runner has to resolve
 * `@atproto/*` → `multiformats/cid` itself, which tsx's CJS resolver can't
 * (ERR_PACKAGE_PATH_NOT_EXPORTED — the exact crash-loop the demo hit). Inside
 * the Next bundle those imports are already resolved by the app's bundler,
 * same as the API routes that use them.
 *
 * Dispatch: one self-scheduling master loop (every 15s) checks each job's
 * elapsed time against its configured cadence — read per tick through
 * `getEffectiveSchedulerConfig()` (env defaults + the admin-editable
 * `SiteSetting` overrides, #59) — so toggles AND cadence changes from
 * /admin/settings apply within a minute, no restart. Cadences are therefore
 * quantized to the 15s master tick (a 60s job fires every 60–75s).
 *
 * Safety in a web server:
 * - every tick is fully try/caught — a job failure can NEVER take the app down;
 * - the master loop schedules the next tick only after the current one
 *   finishes, and runPublishTick() additionally carries an in-flight guard, so
 *   publish sweeps never overlap in-process (a slow delivery racing a later
 *   retry sweep is how a crosspost could double-fire);
 * - timers are unref()'d so they never hold the process open on shutdown;
 * - a globalThis guard makes startScheduler() idempotent per process (dev
 *   server restarts / duplicate register calls can't stack loops);
 * - overlapping instances are safe: publishing claims each post atomically.
 */

const globalScheduler = globalThis as typeof globalThis & {
  __fedihomeSchedulerStarted?: boolean;
  __fedihomeSchedulerLastTickAt?: number;
};

const MASTER_TICK_MS = 15_000;
const lastRun = { publish: 0, bluesky: 0, delivery: 0, crosspost: 0, storage: 0, retention: 0 };

/**
 * When the master loop last completed a pass (#358).
 *
 * The scheduler runs IN-PROCESS, so it can wedge while HTTP keeps answering
 * 200 — an instance that looks perfectly healthy while silently no longer
 * publishing scheduled posts. Exposing this lets /api/health say so.
 *
 * Stored on globalThis, NOT in a module-level variable. instrumentation.ts
 * reaches this module through a dynamic import while the health route imports
 * it statically, and those resolve to SEPARATE module instances — a plain
 * `let` is written by the scheduler's copy and read as undefined by the route's.
 * Verified in a container: `schedulerStarted()` (already on globalThis) crossed
 * the boundary correctly while a module-level tick stamp stayed null forever.
 * The existing `__fedihomeSchedulerStarted` flag is here for the same reason.
 */
export function schedulerLastTickAgoMs(): number | null {
  const at = globalScheduler.__fedihomeSchedulerLastTickAt;
  return typeof at === "number" ? Date.now() - at : null;
}

/** Whether this process started the scheduler at all. */
export function schedulerStarted(): boolean {
  return !!globalScheduler.__fedihomeSchedulerStarted;
}

/** How often the loop is expected to run — so a consumer can judge staleness. */
export const SCHEDULER_TICK_MS = MASTER_TICK_MS;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] scheduler: ${msg}`);
}

// Publish sweeps must never overlap in-process: a slow delivery racing a later
// tick's retry sweep is how a crosspost could double-fire.
let publishTickInFlight = false;

export async function runPublishTick(): Promise<void> {
  if (publishTickInFlight) return;
  // Claim the flag SYNCHRONOUSLY — an await before it would open a suspension
  // window where two callers both pass the check.
  publishTickInFlight = true;
  try {
    if (!(await getEffectiveSchedulerConfig()).publishScheduled.enabled) return;
    const n = await publishDueScheduledPosts();
    if (n > 0) log(`published ${n} scheduled post(s)`);
  } catch (err) {
    console.error("scheduler: publish-scheduled failed:", err);
  } finally {
    publishTickInFlight = false;
  }
}

export async function runBlueskySyncTick(): Promise<void> {
  if (!(await getEffectiveSchedulerConfig()).blueskySync.enabled) return;
  try {
    const g = await syncBlueskyGraph();
    const d = await pollBlueskyDMs();
    const n = await syncBlueskyNotifications();
    log(`bluesky-sync: ${g.followers}/${g.following} graph, ${d.messages} dms, ${n.pushed} pushed`);
  } catch (err) {
    console.error("scheduler: bluesky-sync failed:", err);
  }
}

export async function runDeliveryRetryTick(): Promise<void> {
  if (!(await getEffectiveSchedulerConfig()).deliveryRetry.enabled) return;
  try {
    const r = await retryFailedDeliveries();
    if (r.claimed > 0 || r.pruned > 0) {
      log(
        `delivery-retry: ${r.delivered} delivered, ${r.gaveUp} gave up, ${r.discarded} discarded (blocked), ${r.claimed} tried, ${r.pruned} pruned`,
      );
    }
  } catch (err) {
    console.error("scheduler: delivery-retry failed:", err);
  }
}

/**
 * Measure uploads usage, then trim the remote-media cache in the same pass (#385).
 *
 * One walk, two purposes. The measurement is what `/api/health` and the admin
 * panel report without stat-ing thousands of files per request — and the trim
 * used to be triggered from exactly one place, fire-and-forget after a *video*
 * was cached, so an instance that only ever cached images never trimmed at all
 * and the 2GB budget was fiction.
 */
export async function runStorageScanTick(): Promise<void> {
  if (!(await getEffectiveSchedulerConfig()).storageScan.enabled) return;
  try {
    const { measureStorageUsage } = await import("./storage-usage");
    const { trimFediStorage } = await import("./fedi-media");

    const trimmed = await trimFediStorage();
    // Measure AFTER trimming, so the reported figure is what's actually on disk.
    const usage = await measureStorageUsage();

    if (trimmed.deleted > 0) {
      log(`storage: trimmed ${trimmed.deleted} cached file(s), freed ${Math.round(trimmed.freedBytes / 1024 / 1024)}MB`);
    }
    if (process.env.FEDIHOME_DEBUG === "true") {
      log(
        `storage: ${Math.round(usage.totalBytes / 1024 / 1024)}MB total, ` +
          `${Math.round(usage.fediCacheBytes / 1024 / 1024)}MB cached remote media`,
      );
    }
  } catch (err) {
    console.error("scheduler: storage scan failed:", err);
  }
}

export async function runCrosspostRetryTick(): Promise<void> {
  if (!(await getEffectiveSchedulerConfig()).crosspostRetry.enabled) return;
  try {
    const r = await retryFailedCrossposts();
    if (r.claimed > 0 || r.pruned > 0) {
      log(`crosspost-retry: ${r.delivered} sent, ${r.gaveUp} gave up, ${r.claimed} tried, ${r.pruned} pruned`);
    }
  } catch (err) {
    console.error("scheduler: crosspost-retry failed:", err);
  }
}

export async function runRetentionSweepTick(): Promise<void> {
  if (!(await getEffectiveSchedulerConfig()).retentionSweep.enabled) return;
  try {
    const r = await pruneStaleFediPosts();
    if (r.pruned > 0 || r.filesRemoved > 0) {
      log(
        `retention: pruned ${r.pruned} remote post(s), ${r.filesRemoved} media file(s)` +
          (r.capped ? " (capped — more next tick)" : ""),
      );
    }
  } catch (err) {
    console.error("scheduler: retention-sweep failed:", err);
  }
}

async function masterTick(): Promise<void> {
  const cfg = await getEffectiveSchedulerConfig();
  const now = Date.now();
  if (cfg.publishScheduled.enabled && now - lastRun.publish >= cfg.publishScheduled.intervalSec * 1000) {
    lastRun.publish = now;
    await runPublishTick();
  }
  if (cfg.blueskySync.enabled && now - lastRun.bluesky >= cfg.blueskySync.intervalSec * 1000) {
    lastRun.bluesky = now;
    await runBlueskySyncTick();
  }
  if (cfg.deliveryRetry.enabled && now - lastRun.delivery >= cfg.deliveryRetry.intervalSec * 1000) {
    lastRun.delivery = now;
    await runDeliveryRetryTick();
  }
  if (cfg.crosspostRetry.enabled && now - lastRun.crosspost >= cfg.crosspostRetry.intervalSec * 1000) {
    lastRun.crosspost = now;
    await runCrosspostRetryTick();
  }
  if (cfg.storageScan.enabled && now - lastRun.storage >= cfg.storageScan.intervalSec * 1000) {
    lastRun.storage = now;
    await runStorageScanTick();
  }
  if (cfg.retentionSweep.enabled && now - lastRun.retention >= cfg.retentionSweep.intervalSec * 1000) {
    lastRun.retention = now;
    await runRetentionSweepTick();
  }
  // Stamped only on a COMPLETED pass, so a loop that hangs mid-tick shows as
  // stale rather than fresh.
  globalScheduler.__fedihomeSchedulerLastTickAt = Date.now();
}

function scheduleNext(): void {
  const timer = setTimeout(async () => {
    try {
      await masterTick();
    } catch (err) {
      console.error("scheduler: tick failed:", err);
    }
    scheduleNext();
  }, MASTER_TICK_MS);
  // Never keep the server process alive just for the scheduler.
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Start the scheduler loop. Idempotent — returns false if this process
 * already started it.
 */
export function startScheduler(): boolean {
  if (globalScheduler.__fedihomeSchedulerStarted) return false;
  globalScheduler.__fedihomeSchedulerStarted = true;

  const cfg = getSchedulerConfig();
  log(
    `starting (in-app) — publish=${cfg.publishScheduled.enabled ? cfg.publishScheduled.intervalSec + "s" : "off"}, ` +
      `bluesky=${cfg.blueskySync.enabled ? cfg.blueskySync.intervalSec + "s" : "off"}, ` +
      `delivery=${cfg.deliveryRetry.enabled ? cfg.deliveryRetry.intervalSec + "s" : "off"}, ` +
      `crosspost=${cfg.crosspostRetry.enabled ? cfg.crosspostRetry.intervalSec + "s" : "off"}, ` +
      `retention=${cfg.retentionSweep.enabled ? cfg.retentionSweep.intervalSec + "s/" + cfg.retentionSweep.retentionDays + "d" : "off"}` +
      ` (env defaults; /admin/settings overrides apply live)`,
  );

  // Publish sweeps start immediately (due posts shouldn't wait a tick); the
  // sync + retry jobs wait out their first full interval.
  lastRun.publish = 0;
  lastRun.bluesky = Date.now();
  lastRun.delivery = Date.now();
  lastRun.crosspost = Date.now();
  // 0, like publish: the admin panel and /api/health would otherwise report
  // "not measured yet" for a full interval after every restart.
  lastRun.storage = 0;
  lastRun.retention = Date.now();

  const boot = masterTick().catch((err) => console.error("scheduler: tick failed:", err));
  void boot;
  scheduleNext();
  return true;
}
