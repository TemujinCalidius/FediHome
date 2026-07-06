import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { siteSetting: { findMany: vi.fn() } } }));

import {
  getSchedulerConfig,
  getEffectiveSchedulerConfig,
  invalidateSchedulerConfigCache,
} from "@/lib/scheduler-config";
import { prisma } from "@/lib/db";

const rows = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSchedulerConfigCache();
  vi.mocked(prisma.siteSetting.findMany).mockResolvedValue([] as never);
  for (const k of [
    "SCHEDULER_PUBLISH_ENABLED", "SCHEDULER_PUBLISH_INTERVAL_SEC",
    "SCHEDULER_BLUESKY_ENABLED", "SCHEDULER_BLUESKY_INTERVAL_SEC", "BLUESKY_HANDLE",
  ]) delete process.env[k];
});

describe("getSchedulerConfig", () => {
  it("defaults: publish on/60s, bluesky off (unconfigured)/900s", () => {
    expect(getSchedulerConfig()).toEqual({
      publishScheduled: { enabled: true, intervalSec: 60 },
      blueskySync: { enabled: false, intervalSec: 900 },
    });
  });

  it("enables bluesky by default when a Bluesky handle is configured", () => {
    process.env.BLUESKY_HANDLE = "me.bsky.social";
    expect(getSchedulerConfig().blueskySync.enabled).toBe(true);
  });

  it("honours env overrides", () => {
    process.env.SCHEDULER_PUBLISH_INTERVAL_SEC = "30";
    process.env.SCHEDULER_PUBLISH_ENABLED = "false";
    process.env.BLUESKY_HANDLE = "me.bsky.social";
    process.env.SCHEDULER_BLUESKY_ENABLED = "false";
    const cfg = getSchedulerConfig();
    expect(cfg.publishScheduled).toEqual({ enabled: false, intervalSec: 30 });
    expect(cfg.blueskySync.enabled).toBe(false); // explicit override beats the handle default
  });

  it("ignores a non-positive interval and falls back to the default", () => {
    process.env.SCHEDULER_PUBLISH_INTERVAL_SEC = "0";
    expect(getSchedulerConfig().publishScheduled.intervalSec).toBe(60);
  });
});

describe("getEffectiveSchedulerConfig (admin overrides, #59)", () => {
  it("no overrides → env defaults", async () => {
    expect(await getEffectiveSchedulerConfig()).toEqual(getSchedulerConfig());
  });

  it("SiteSetting overrides beat env defaults", async () => {
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "scheduler.publish.enabled": "false", "scheduler.publish.intervalSec": "120" }) as never,
    );
    const cfg = await getEffectiveSchedulerConfig();
    expect(cfg.publishScheduled).toEqual({ enabled: false, intervalSec: 120 });
    expect(cfg.blueskySync.intervalSec).toBe(900); // untouched job keeps its default
  });

  it("clamps insane intervals back to the default (10s–24h window)", async () => {
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "scheduler.publish.intervalSec": "1", "scheduler.bluesky.intervalSec": "999999" }) as never,
    );
    const cfg = await getEffectiveSchedulerConfig();
    expect(cfg.publishScheduled.intervalSec).toBe(60);
    expect(cfg.blueskySync.intervalSec).toBe(900);
  });

  it("caches for a minute, and invalidation forces a re-read", async () => {
    await getEffectiveSchedulerConfig();
    await getEffectiveSchedulerConfig();
    expect(prisma.siteSetting.findMany).toHaveBeenCalledTimes(1); // cached
    invalidateSchedulerConfigCache();
    await getEffectiveSchedulerConfig();
    expect(prisma.siteSetting.findMany).toHaveBeenCalledTimes(2);
  });

  it("falls back to env defaults (uncached) when the DB is unreachable", async () => {
    vi.mocked(prisma.siteSetting.findMany).mockRejectedValue(new Error("db down"));
    expect(await getEffectiveSchedulerConfig()).toEqual(getSchedulerConfig());
    // Failure wasn't cached — the next call tries the DB again.
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "scheduler.publish.intervalSec": "120" }) as never,
    );
    expect((await getEffectiveSchedulerConfig()).publishScheduled.intervalSec).toBe(120);
  });
});
