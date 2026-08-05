import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  getSchedulerConfig, getEffectiveSchedulerConfig,
  publishDueScheduledPosts, syncBlueskyGraph, pollBlueskyDMs, syncBlueskyNotifications, retryFailedDeliveries, retryFailedCrossposts, pruneStaleFediPosts,
  measureStorageUsage, trimFediStorage, syncBlueskyFeed, startUpdateCheck,
} = vi.hoisted(() => ({
  getSchedulerConfig: vi.fn(),
  getEffectiveSchedulerConfig: vi.fn(),
  publishDueScheduledPosts: vi.fn(),
  syncBlueskyGraph: vi.fn(),
  pollBlueskyDMs: vi.fn(),
  syncBlueskyNotifications: vi.fn(),
  retryFailedDeliveries: vi.fn(),
  retryFailedCrossposts: vi.fn(),
  pruneStaleFediPosts: vi.fn(),
  measureStorageUsage: vi.fn(),
  trimFediStorage: vi.fn(),
  syncBlueskyFeed: vi.fn(),
  startUpdateCheck: vi.fn(),
}));
vi.mock("@/lib/scheduler-config", () => ({ getSchedulerConfig, getEffectiveSchedulerConfig }));
vi.mock("@/lib/publish-post", () => ({ publishDueScheduledPosts }));
vi.mock("@/lib/bluesky-graph", () => ({ syncBlueskyGraph }));
vi.mock("@/lib/bluesky-dm-poll", () => ({ pollBlueskyDMs }));
vi.mock("@/lib/bluesky-notifications", () => ({ syncBlueskyNotifications }));
vi.mock("@/lib/delivery-retry", () => ({ retryFailedDeliveries }));
vi.mock("@/lib/crosspost-retry", () => ({ retryFailedCrossposts }));
vi.mock("@/lib/fedi-retention", () => ({ pruneStaleFediPosts }));
// The storage scan walks the real filesystem; without this it would stall the
// tick under fake timers and the jobs after it would never dispatch.
vi.mock("@/lib/storage-usage", () => ({ measureStorageUsage }));
// The Bluesky sync now imports the following feed too (#393).
vi.mock("@/lib/bluesky-feed", () => ({ syncBlueskyFeed }));
vi.mock("@/lib/fedi-media", () => ({ trimFediStorage }));
// The update check spawns a child process and reads the persisted watermark (#399);
// without this it would do real I/O inside the tick.
vi.mock("@/lib/update-check", () => ({ startUpdateCheck }));

import { startScheduler, runPublishTick, runBlueskySyncTick, runDeliveryRetryTick, runCrosspostRetryTick, runRetentionSweepTick, runStorageScanTick, runUpdateCheckTick } from "@/lib/scheduler";

const cfg = (over: Record<string, unknown> = {}) => ({
  publishScheduled: { enabled: true, intervalSec: 60 },
  blueskySync: { enabled: true, intervalSec: 900 },
  deliveryRetry: { enabled: false, intervalSec: 60 },
  crosspostRetry: { enabled: false, intervalSec: 60 },
  storageScan: { enabled: false, intervalSec: 3600 },
  updateCheck: { enabled: false, intervalSec: 86_400 },
  retentionSweep: { enabled: false, intervalSec: 86_400, retentionDays: 90 },
  exploreSync: { enabled: false, intervalSec: 3600 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  delete (globalThis as { __fedihomeSchedulerStarted?: boolean }).__fedihomeSchedulerStarted;
  getSchedulerConfig.mockReturnValue(cfg());
  getEffectiveSchedulerConfig.mockResolvedValue(cfg());
  publishDueScheduledPosts.mockResolvedValue(0);
  syncBlueskyGraph.mockResolvedValue({ followers: 1, following: 2 });
  syncBlueskyFeed.mockResolvedValue({ fetched: 0, imported: 0, skippedBlocked: 0 });
  pollBlueskyDMs.mockResolvedValue({ messages: 0 });
  syncBlueskyNotifications.mockResolvedValue({ pushed: 0 });
  retryFailedDeliveries.mockResolvedValue({ claimed: 0, delivered: 0, gaveUp: 0, pruned: 0 });
  retryFailedCrossposts.mockResolvedValue({ claimed: 0, delivered: 0, gaveUp: 0, pruned: 0 });
  pruneStaleFediPosts.mockResolvedValue({ scanned: 0, pruned: 0, filesRemoved: 0, capped: false });
  startUpdateCheck.mockResolvedValue({ started: false, reason: "not-due" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("in-app scheduler (#183/#59)", () => {
  it("is idempotent per process — a second start is a no-op", async () => {
    expect(startScheduler()).toBe(true);
    expect(startScheduler()).toBe(false);
    // One loop only: one immediate publish sweep, then one more after 60s elapse.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(2); // startup + 1 due tick
  });

  it("runs the publish sweep immediately at startup, then on its cadence", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(3);
  });

  it("runs the Bluesky sync only after its own (longer) cadence has elapsed", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(885_000);
    expect(syncBlueskyGraph).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000 * 2);
    expect(syncBlueskyGraph).toHaveBeenCalledTimes(1);
    expect(pollBlueskyDMs).toHaveBeenCalledTimes(1);
    expect(syncBlueskyNotifications).toHaveBeenCalledTimes(1);
  });

  it("re-reads the EFFECTIVE config every tick — admin toggles apply without restart (#59)", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(2);
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ publishScheduled: { enabled: false, intervalSec: 60 } }));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(2); // no more runs
  });

  it("admin cadence changes apply live too", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ publishScheduled: { enabled: true, intervalSec: 600 } }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(1); // startup only — 600s cadence
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ publishScheduled: { enabled: true, intervalSec: 60 } }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publishDueScheduledPosts.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a disabled bluesky job never runs its sync", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ blueskySync: { enabled: false, intervalSec: 900 } }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(syncBlueskyGraph).not.toHaveBeenCalled();
  });

  it("dispatches the delivery-retry job on its cadence when enabled (#207)", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ deliveryRetry: { enabled: true, intervalSec: 60 } }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retryFailedDeliveries).toHaveBeenCalled();
  });

  it("never runs delivery retry when the job is disabled", async () => {
    // cfg() defaults deliveryRetry off.
    startScheduler();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(retryFailedDeliveries).not.toHaveBeenCalled();
  });

  it("dispatches the crosspost-retry job on its cadence when enabled (#225)", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ crosspostRetry: { enabled: true, intervalSec: 60 } }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retryFailedCrossposts).toHaveBeenCalled();
  });

  it("never runs crosspost retry when the job is disabled", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(retryFailedCrossposts).not.toHaveBeenCalled();
  });

  it("dispatches the retention sweep on its cadence when enabled (#240)", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ retentionSweep: { enabled: true, intervalSec: 60, retentionDays: 90 } }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pruneStaleFediPosts).toHaveBeenCalled();
  });

  it("never runs the retention sweep when disabled (default OFF)", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(pruneStaleFediPosts).not.toHaveBeenCalled();
  });

  it("runRetentionSweepTick swallows a failure (web-server safety)", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ retentionSweep: { enabled: true, intervalSec: 60, retentionDays: 90 } }));
    pruneStaleFediPosts.mockRejectedValue(new Error("db down"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runRetentionSweepTick()).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("runCrosspostRetryTick swallows a failure (web-server safety)", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ crosspostRetry: { enabled: true, intervalSec: 60 } }));
    retryFailedCrossposts.mockRejectedValue(new Error("bsky down"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runCrosspostRetryTick()).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("runDeliveryRetryTick swallows a failure (web-server safety)", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ deliveryRetry: { enabled: true, intervalSec: 60 } }));
    retryFailedDeliveries.mockRejectedValue(new Error("db down"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runDeliveryRetryTick()).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("publish ticks never overlap in-process (a slow delivery can't race a later tick's retry sweep)", async () => {
    let release!: () => void;
    publishDueScheduledPosts.mockReturnValue(new Promise<number>((res) => { release = () => res(0); }));
    const first = runPublishTick(); // starts, blocks on the pending sweep
    await runPublishTick(); // fires while the first is in flight → must skip
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(1);
    release();
    await first;
    publishDueScheduledPosts.mockResolvedValue(0);
    await runPublishTick(); // after completion the guard is released
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(2);
  });

  it("a failing job tick never throws out of the scheduler (web-server safety)", async () => {
    publishDueScheduledPosts.mockRejectedValue(new Error("db down"));
    syncBlueskyGraph.mockRejectedValue(new Error("bsky down"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runPublishTick()).resolves.toBeUndefined();
    await expect(runBlueskySyncTick()).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
    // and the loop keeps ticking after failures
    publishDueScheduledPosts.mockClear();
    startScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(3);
  });
});

/**
 * Scheduler liveness (#358).
 *
 * The state lives on globalThis, not in a module-level variable — verified in a
 * container that instrumentation.ts (dynamic import) and the health route
 * (static import) resolve to SEPARATE module instances, so a plain `let` is
 * written by one copy and read as undefined by the other.
 */
describe("scheduler liveness is readable across module instances", () => {
  const g = globalThis as typeof globalThis & {
    __fedihomeSchedulerLastTickAt?: number;
    __fedihomeSchedulerStarted?: boolean;
  };

  it("reports null before any tick has completed", async () => {
    delete g.__fedihomeSchedulerLastTickAt;
    const { schedulerLastTickAgoMs } = await import("@/lib/scheduler");
    expect(schedulerLastTickAgoMs()).toBeNull();
  });

  it("reports elapsed time once a tick has stamped globalThis", async () => {
    g.__fedihomeSchedulerLastTickAt = Date.now() - 5_000;
    const { schedulerLastTickAgoMs } = await import("@/lib/scheduler");
    const ago = schedulerLastTickAgoMs();
    expect(ago).not.toBeNull();
    expect(ago!).toBeGreaterThanOrEqual(4_500);
  });

  it("reads the started flag from globalThis too", async () => {
    const { schedulerStarted } = await import("@/lib/scheduler");
    g.__fedihomeSchedulerStarted = true;
    expect(schedulerStarted()).toBe(true);
  });
});

describe("storage scan (#385)", () => {
  it("trims the remote-media cache and records usage on its cadence", async () => {
    // The trim used to fire only after a cached VIDEO, so an image-only instance
    // never trimmed and the 2GB budget was fiction. One walk now does both.
    trimFediStorage.mockResolvedValue({ deleted: 0, freedBytes: 0 });
    measureStorageUsage.mockResolvedValue({ totalBytes: 0, fediCacheBytes: 0, ownBytes: 0, measuredAt: "" });
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ storageScan: { enabled: true, intervalSec: 3600 } }));

    await runStorageScanTick();

    expect(trimFediStorage).toHaveBeenCalled();
    expect(measureStorageUsage).toHaveBeenCalled();
  });

  it("does nothing when the job is switched off", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ storageScan: { enabled: false, intervalSec: 3600 } }));
    await runStorageScanTick();
    expect(trimFediStorage).not.toHaveBeenCalled();
  });

  it("measures AFTER trimming, so the figure reflects what is actually on disk", async () => {
    const order: string[] = [];
    trimFediStorage.mockImplementation(async () => {
      order.push("trim");
      return { deleted: 1, freedBytes: 10 };
    });
    measureStorageUsage.mockImplementation(async () => {
      order.push("measure");
      return { totalBytes: 0, fediCacheBytes: 0, ownBytes: 0, measuredAt: "" };
    });
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ storageScan: { enabled: true, intervalSec: 3600 } }));

    await runStorageScanTick();

    expect(order).toEqual(["trim", "measure"]);
  });

  it("a failed scan cannot take the tick down", async () => {
    trimFediStorage.mockRejectedValue(new Error("disk gone"));
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ storageScan: { enabled: true, intervalSec: 3600 } }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runStorageScanTick()).resolves.toBeUndefined();
  });
});


describe("the update check job (#399)", () => {
  it("attempts a check at startup, and lets the watermark decide", async () => {
    // Deliberately attempted on boot: an instance that has been switched off for a
    // week should find out about a security advisory when it comes back, not 24
    // hours later. The persisted watermark inside startUpdateCheck is what makes
    // that safe — this call is one indexed lookup when nothing is due.
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ updateCheck: { enabled: true, intervalSec: 86_400 } }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(1);
    expect(startUpdateCheck).toHaveBeenCalledWith({ intervalSec: 86_400 });
  });

  it("passes the CONFIGURED interval, so an admin override actually changes the cadence", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ updateCheck: { enabled: true, intervalSec: 43_200 } }));
    await runUpdateCheckTick();
    expect(startUpdateCheck).toHaveBeenCalledWith({ intervalSec: 43_200 });
  });

  it("never forces — only the admin button does that", async () => {
    // A forced scheduled run would bypass the watermark and check on every tick.
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ updateCheck: { enabled: true, intervalSec: 86_400 } }));
    await runUpdateCheckTick();
    expect(startUpdateCheck.mock.calls[0][0]).not.toHaveProperty("force", true);
  });

  it("does nothing at all when the job is disabled", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ updateCheck: { enabled: false, intervalSec: 86_400 } }));
    await runUpdateCheckTick();
    expect(startUpdateCheck).not.toHaveBeenCalled();
  });

  it("a failure never throws out of the tick", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue(cfg({ updateCheck: { enabled: true, intervalSec: 86_400 } }));
    startUpdateCheck.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runUpdateCheckTick()).resolves.toBeUndefined();
  });
});
