import { describe, it, expect, beforeEach } from "vitest";
import { getSchedulerConfig } from "@/lib/scheduler-config";

beforeEach(() => {
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
