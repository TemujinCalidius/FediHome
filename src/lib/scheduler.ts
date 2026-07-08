import { getSchedulerConfig, getEffectiveSchedulerConfig } from "./scheduler-config";
import { publishDueScheduledPosts } from "./publish-post";
import { syncBlueskyGraph } from "./bluesky-graph";
import { pollBlueskyDMs } from "./bluesky-dm-poll";
import { syncBlueskyNotifications } from "./bluesky-notifications";
import { retryFailedDeliveries } from "./delivery-retry";
import { retryFailedCrossposts } from "./crosspost-retry";

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
};

const MASTER_TICK_MS = 15_000;
const lastRun = { publish: 0, bluesky: 0, delivery: 0, crosspost: 0 };

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
      log(`delivery-retry: ${r.delivered} delivered, ${r.gaveUp} gave up, ${r.claimed} tried, ${r.pruned} pruned`);
    }
  } catch (err) {
    console.error("scheduler: delivery-retry failed:", err);
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
      `crosspost=${cfg.crosspostRetry.enabled ? cfg.crosspostRetry.intervalSec + "s" : "off"}` +
      ` (env defaults; /admin/settings overrides apply live)`,
  );

  // Publish sweeps start immediately (due posts shouldn't wait a tick); the
  // sync + retry jobs wait out their first full interval.
  lastRun.publish = 0;
  lastRun.bluesky = Date.now();
  lastRun.delivery = Date.now();
  lastRun.crosspost = Date.now();

  const boot = masterTick().catch((err) => console.error("scheduler: tick failed:", err));
  void boot;
  scheduleNext();
  return true;
}
