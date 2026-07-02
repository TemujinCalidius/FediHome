/**
 * FediHome scheduler — ONE long-running process that runs all periodic jobs
 * (publishing due scheduled posts, Bluesky sync). It replaces the per-job cron
 * scripts: it's declared in ecosystem.config.cjs, so `pm2 start ecosystem.config.cjs`
 * brings it up automatically alongside the app — no hand-rolled cron needed.
 *
 * Run standalone (dev / debugging):
 *   npx tsx --env-file=.env.local scripts/scheduler.ts
 *
 * Cadences come from src/lib/scheduler-config.ts (env now, admin-editable when the
 * admin backend lands). Each job is isolated (a failure never blocks the others),
 * and re-checks its enabled flag each run so it can be toggled without a restart.
 */
import { getSchedulerConfig } from "../src/lib/scheduler-config";
import { publishDueScheduledPosts } from "../src/lib/publish-post";
import { syncBlueskyGraph } from "../src/lib/bluesky-graph";
import { pollBlueskyDMs } from "../src/lib/bluesky-dm-poll";
import { syncBlueskyNotifications } from "../src/lib/bluesky-notifications";

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] scheduler: ${msg}`);
}

async function runPublish() {
  if (!getSchedulerConfig().publishScheduled.enabled) return;
  try {
    const n = await publishDueScheduledPosts();
    if (n > 0) log(`published ${n} scheduled post(s)`);
  } catch (err) {
    console.error("publish-scheduled failed:", err);
  }
}

async function runBlueskySync() {
  if (!getSchedulerConfig().blueskySync.enabled) return;
  try {
    const g = await syncBlueskyGraph();
    const d = await pollBlueskyDMs();
    const n = await syncBlueskyNotifications();
    log(`bluesky-sync: ${g.followers}/${g.following} graph, ${d.messages} dms, ${n.pushed} pushed`);
  } catch (err) {
    console.error("bluesky-sync failed:", err);
  }
}

function main() {
  const cfg = getSchedulerConfig();
  log(
    `starting — publish=${cfg.publishScheduled.enabled ? cfg.publishScheduled.intervalSec + "s" : "off"}, ` +
      `bluesky=${cfg.blueskySync.enabled ? cfg.blueskySync.intervalSec + "s" : "off"}`
  );

  if (cfg.publishScheduled.enabled) {
    void runPublish(); // run once at startup so due posts don't wait a full tick
    setInterval(() => void runPublish(), cfg.publishScheduled.intervalSec * 1000);
  }
  if (cfg.blueskySync.enabled) {
    setInterval(() => void runBlueskySync(), cfg.blueskySync.intervalSec * 1000);
  }

  // setInterval keeps the event loop alive; PM2 restarts on crash.
}

main();
