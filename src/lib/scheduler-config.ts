/**
 * FediHome scheduler configuration (#183).
 *
 * The single scheduler process (`scripts/scheduler.ts`) reads its job cadences
 * from here. TODAY these come from env vars with sensible defaults. When the
 * proper admin backend lands (#59), this function can read DB rows instead
 * (falling back to these defaults) so the cadences are editable in-app — the
 * scheduler consults it, so no scheduler rewrite is needed.
 */

export interface SchedulerJobConfig {
  enabled: boolean;
  intervalSec: number;
}

export interface SchedulerConfig {
  publishScheduled: SchedulerJobConfig;
  blueskySync: SchedulerJobConfig;
}

function posNum(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return value !== "false" && value !== "0";
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
  };
}
