import { getSchedulerConfig } from "./scheduler-config";
import { publishDueScheduledPosts } from "./publish-post";
import { syncBlueskyGraph } from "./bluesky-graph";
import { pollBlueskyDMs } from "./bluesky-dm-poll";
import { syncBlueskyNotifications } from "./bluesky-notifications";

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
 * Safety in a web server:
 * - every tick is fully try/caught — a job failure can NEVER take the app down;
 * - intervals are unref()'d so they never hold the process open on shutdown;
 * - a globalThis guard makes startScheduler() idempotent per process (dev
 *   server restarts / duplicate register calls can't stack intervals);
 * - overlapping instances are safe: publishing claims each post atomically.
 *
 * Both jobs re-check their enabled flag every tick, so SCHEDULER_* toggles
 * (and later, admin-backend settings) take effect without touching intervals.
 * Cadences are read once at boot.
 */

const globalScheduler = globalThis as typeof globalThis & {
  __fedihomeSchedulerStarted?: boolean;
};

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] scheduler: ${msg}`);
}

// Publish sweeps must never overlap in-process: a slow delivery racing a later
// tick's retry sweep is how a crosspost could double-fire.
let publishTickInFlight = false;

export async function runPublishTick(): Promise<void> {
  if (publishTickInFlight) return;
  if (!getSchedulerConfig().publishScheduled.enabled) return;
  publishTickInFlight = true;
  try {
    const n = await publishDueScheduledPosts();
    if (n > 0) log(`published ${n} scheduled post(s)`);
  } catch (err) {
    console.error("scheduler: publish-scheduled failed:", err);
  } finally {
    publishTickInFlight = false;
  }
}

export async function runBlueskySyncTick(): Promise<void> {
  if (!getSchedulerConfig().blueskySync.enabled) return;
  try {
    const g = await syncBlueskyGraph();
    const d = await pollBlueskyDMs();
    const n = await syncBlueskyNotifications();
    log(`bluesky-sync: ${g.followers}/${g.following} graph, ${d.messages} dms, ${n.pushed} pushed`);
  } catch (err) {
    console.error("scheduler: bluesky-sync failed:", err);
  }
}

function everySeconds(seconds: number, tick: () => Promise<void>) {
  const timer = setInterval(() => void tick(), seconds * 1000);
  // Never keep the server process alive just for the scheduler.
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Start the scheduler loops. Idempotent — returns false if this process
 * already started them.
 */
export function startScheduler(): boolean {
  if (globalScheduler.__fedihomeSchedulerStarted) return false;
  globalScheduler.__fedihomeSchedulerStarted = true;

  const cfg = getSchedulerConfig();
  log(
    `starting (in-app) — publish=${cfg.publishScheduled.enabled ? cfg.publishScheduled.intervalSec + "s" : "off"}, ` +
      `bluesky=${cfg.blueskySync.enabled ? cfg.blueskySync.intervalSec + "s" : "off"}`,
  );

  // Run the publish sweep once at startup so due posts don't wait a full tick.
  void runPublishTick();
  everySeconds(cfg.publishScheduled.intervalSec, runPublishTick);
  everySeconds(cfg.blueskySync.intervalSec, runBlueskySyncTick);
  return true;
}
