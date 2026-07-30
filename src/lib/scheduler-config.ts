/**
 * FediHome scheduler configuration (#183, #59).
 *
 * Two layers:
 *  - `getSchedulerConfig()` — the env-var defaults (SCHEDULER_*), sync.
 *  - `getEffectiveSchedulerConfig()` — env defaults overlaid with the
 *    admin-editable overrides stored in `SiteSetting` (`scheduler.*` keys,
 *    written by /admin/settings), cached for 60s so the scheduler can consult
 *    it every tick without hammering the DB. Overrides win; deleting an
 *    override reverts to the env/default value. DB unavailable → env defaults.
 */

import { prisma } from "./db";

export interface SchedulerJobConfig {
  enabled: boolean;
  intervalSec: number;
}

/** The retention sweep also carries the age window (#240). */
export interface RetentionJobConfig extends SchedulerJobConfig {
  retentionDays: number;
}

export interface SchedulerConfig {
  publishScheduled: SchedulerJobConfig;
  blueskySync: SchedulerJobConfig;
  deliveryRetry: SchedulerJobConfig;
  crosspostRetry: SchedulerJobConfig;
  storageScan: SchedulerJobConfig;
  updateCheck: SchedulerJobConfig;
  retentionSweep: RetentionJobConfig;
}

// Retention window bounds (#240): a 7-day floor blocks the 0-day "delete
// everything" foot-gun; the ceiling is a sanity cap. Shared by the env default,
// the admin override, and the /admin/settings validation.
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 3650;

function posNum(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return value !== "false" && value !== "0";
}

/** Retention window in days, clamped to [MIN,MAX]; out-of-range → fallback. */
function clampDays(value: string | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored >= MIN_RETENTION_DAYS && floored <= MAX_RETENTION_DAYS ? floored : fallback;
}

export function getSchedulerConfig(): SchedulerConfig {
  return {
    // Publish due scheduled posts. Default: on, every 60s.
    publishScheduled: {
      enabled: flag(process.env.SCHEDULER_PUBLISH_ENABLED, true),
      intervalSec: posNum(process.env.SCHEDULER_PUBLISH_INTERVAL_SEC, 60),
    },
    // Bluesky graph/DM/notification sync. Default: on every 15 min, but only when
    // Bluesky is configured (else the sync no-ops and would just log noise).
    blueskySync: {
      enabled: flag(process.env.SCHEDULER_BLUESKY_ENABLED, !!process.env.BLUESKY_HANDLE),
      intervalSec: posNum(process.env.SCHEDULER_BLUESKY_INTERVAL_SEC, 900),
    },
    // Retry failed follower deliveries (#207). Default: on, every 60s.
    deliveryRetry: {
      enabled: flag(process.env.SCHEDULER_DELIVERY_ENABLED, true),
      intervalSec: posNum(process.env.SCHEDULER_DELIVERY_INTERVAL_SEC, 60),
    },
    // Measure uploads usage and trim the remote-media cache (#385). Default: on,
    // hourly. The walk stats every file, so it deliberately doesn't run per
    // request — and it is also the ONLY thing that trims the cache on an
    // image-only instance, since the old trigger fired solely after a video.
    storageScan: {
      enabled: flag(process.env.SCHEDULER_STORAGE_ENABLED, true),
      intervalSec: posNum(process.env.SCHEDULER_STORAGE_INTERVAL_SEC, 3600),
    },
    // Check for package updates, security advisories and new FediHome releases
    // (#399). Default: on, daily — daily is also the slowest cadence the system
    // permits, since MAX_INTERVAL_SEC is 24h.
    //
    // On by default because the alternative was what shipped: the check existed,
    // nothing ran it, and an instance never heard about a security advisory. It
    // makes outbound requests to the npm registry and the GitHub API, which is
    // why it's a visible toggle rather than something buried.
    updateCheck: {
      enabled: flag(process.env.SCHEDULER_UPDATE_CHECK_ENABLED, true),
      intervalSec: posNum(process.env.SCHEDULER_UPDATE_CHECK_INTERVAL_SEC, 86_400),
    },
    // Retry failed Bluesky/Threads crossposts (#225). Default: on, every 60s.
    crosspostRetry: {
      enabled: flag(process.env.SCHEDULER_CROSSPOST_ENABLED, true),
      intervalSec: posNum(process.env.SCHEDULER_CROSSPOST_INTERVAL_SEC, 60),
    },
    // Prune stale cached REMOTE federated posts (#240). Default: OFF (opt-in —
    // it deletes data), daily, keep 90 days.
    retentionSweep: {
      enabled: flag(process.env.SCHEDULER_RETENTION_ENABLED, false),
      intervalSec: posNum(process.env.SCHEDULER_RETENTION_INTERVAL_SEC, 86_400),
      retentionDays: clampDays(process.env.SCHEDULER_RETENTION_DAYS, 90),
    },
  };
}

/* ------------------- admin-editable DB overrides (#59) ------------------- */

/** SiteSetting keys the admin settings screen may write, with validation. */
export const SCHEDULER_SETTING_KEYS = [
  "scheduler.publish.enabled",
  "scheduler.publish.intervalSec",
  "scheduler.bluesky.enabled",
  "scheduler.bluesky.intervalSec",
  "scheduler.delivery.enabled",
  "scheduler.delivery.intervalSec",
  "scheduler.crosspost.enabled",
  "scheduler.crosspost.intervalSec",
  "scheduler.storage.enabled",
  "scheduler.storage.intervalSec",
  "scheduler.updateCheck.enabled",
  "scheduler.updateCheck.intervalSec",
  "scheduler.retention.enabled",
  "scheduler.retention.intervalSec",
  "scheduler.retention.days",
] as const;

export type SchedulerSettingKey = (typeof SCHEDULER_SETTING_KEYS)[number];

// Keep operator mistakes from wedging the scheduler: cadences are clamped to
// [10s, 24h] — outside that, the override is ignored (env/default wins).
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 86_400;

function overrideNum(value: string | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored >= MIN_INTERVAL_SEC && floored <= MAX_INTERVAL_SEC ? floored : fallback;
}

function overrideFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return value !== "false" && value !== "0";
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; cfg: SchedulerConfig } | null = null;

/** Drop the cache — called after the admin saves settings so they apply on the next tick. */
export function invalidateSchedulerConfigCache(): void {
  cache = null;
}

/**
 * Env defaults + SiteSetting overrides. Safe to call every scheduler tick
 * (60s cache); falls back to plain env config if the DB is unreachable.
 */
export async function getEffectiveSchedulerConfig(): Promise<SchedulerConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.cfg;

  const base = getSchedulerConfig();
  let cfg = base;
  try {
    const rows = await prisma.siteSetting.findMany({
      // Also fetch the Bluesky integration handle (same query, no extra round-trip)
      // so the sync job's default-enable reflects credentials set via /admin/integrations,
      // not just the BLUESKY_HANDLE env var.
      where: { key: { in: [...SCHEDULER_SETTING_KEYS, "integration.bluesky.handle"] } },
    });
    const o = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // Bluesky is "configured" when a handle exists in the DB (admin panel) or env.
    const bskyConfigured = !!(o["integration.bluesky.handle"] || process.env.BLUESKY_HANDLE);
    cfg = {
      publishScheduled: {
        enabled: overrideFlag(o["scheduler.publish.enabled"], base.publishScheduled.enabled),
        intervalSec: overrideNum(o["scheduler.publish.intervalSec"], base.publishScheduled.intervalSec),
      },
      blueskySync: {
        enabled: overrideFlag(o["scheduler.bluesky.enabled"], base.blueskySync.enabled || bskyConfigured),
        intervalSec: overrideNum(o["scheduler.bluesky.intervalSec"], base.blueskySync.intervalSec),
      },
      deliveryRetry: {
        enabled: overrideFlag(o["scheduler.delivery.enabled"], base.deliveryRetry.enabled),
        intervalSec: overrideNum(o["scheduler.delivery.intervalSec"], base.deliveryRetry.intervalSec),
      },
      crosspostRetry: {
        enabled: overrideFlag(o["scheduler.crosspost.enabled"], base.crosspostRetry.enabled),
        intervalSec: overrideNum(o["scheduler.crosspost.intervalSec"], base.crosspostRetry.intervalSec),
      },
      storageScan: {
        enabled: overrideFlag(o["scheduler.storage.enabled"], base.storageScan.enabled),
        intervalSec: overrideNum(o["scheduler.storage.intervalSec"], base.storageScan.intervalSec),
      },
      updateCheck: {
        enabled: overrideFlag(o["scheduler.updateCheck.enabled"], base.updateCheck.enabled),
        intervalSec: overrideNum(o["scheduler.updateCheck.intervalSec"], base.updateCheck.intervalSec),
      },
      retentionSweep: {
        enabled: overrideFlag(o["scheduler.retention.enabled"], base.retentionSweep.enabled),
        intervalSec: overrideNum(o["scheduler.retention.intervalSec"], base.retentionSweep.intervalSec),
        retentionDays: clampDays(o["scheduler.retention.days"], base.retentionSweep.retentionDays),
      },
    };
  } catch {
    return base; // DB down/mid-migration — env defaults, and don't cache the failure
  }

  cache = { at: Date.now(), cfg };
  return cfg;
}
