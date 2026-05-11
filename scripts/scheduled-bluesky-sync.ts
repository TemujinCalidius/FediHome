#!/usr/bin/env tsx
/**
 * Scheduled Bluesky sync. Runs once and exits.
 *
 * Pulls the authenticated user's Bluesky follower/following graph and recent
 * DMs into the local database. Idempotent — safe to re-run.
 *
 * Schedule via PM2 cron (run from the project root, replace <name> with whatever
 * matches your existing PM2 entries):
 *
 *   pm2 start "npx tsx --env-file=.env.local scripts/scheduled-bluesky-sync.ts" \
 *     --name <name>-bluesky-cron \
 *     --cron-restart "0 3 * * *" \
 *     --no-autorestart
 *   pm2 save
 *
 * Or system cron:
 *
 *   0 3 * * * cd /path/to/fedihome && npx tsx --env-file=.env.local scripts/scheduled-bluesky-sync.ts >> /tmp/bluesky-sync.log 2>&1
 *
 * Manual one-shot:
 *
 *   npx tsx --env-file=.env.local scripts/scheduled-bluesky-sync.ts
 */
import { syncBlueskyGraph } from "../src/lib/bluesky-graph";
import { pollBlueskyDMs } from "../src/lib/bluesky-dm-poll";

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] scheduled-bluesky-sync starting`);

  try {
    const graph = await syncBlueskyGraph();
    console.log(`  graph: ${graph.followers} followers, ${graph.following} following`);
  } catch (err) {
    console.error("  graph sync failed:", err);
  }

  try {
    const dms = await pollBlueskyDMs();
    console.log(`  dms:   ${dms.convos} convos, ${dms.messages} messages`);
  } catch (err) {
    console.error("  dms poll failed:", err);
  }

  console.log(`[${new Date().toISOString()}] scheduled-bluesky-sync done`);
}

main()
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
