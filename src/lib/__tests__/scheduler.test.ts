import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  getSchedulerConfig, getEffectiveSchedulerConfig,
  publishDueScheduledPosts, syncBlueskyGraph, pollBlueskyDMs, syncBlueskyNotifications, retryFailedDeliveries, retryFailedCrossposts, pruneStaleFediPosts,
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
}));
vi.mock("@/lib/scheduler-config", () => ({ getSchedulerConfig, getEffectiveSchedulerConfig }));
vi.mock("@/lib/publish-post", () => ({ publishDueScheduledPosts }));
vi.mock("@/lib/bluesky-graph", () => ({ syncBlueskyGraph }));
vi.mock("@/lib/bluesky-dm-poll", () => ({ pollBlueskyDMs }));
vi.mock("@/lib/bluesky-notifications", () => ({ syncBlueskyNotifications }));
vi.mock("@/lib/delivery-retry", () => ({ retryFailedDeliveries }));
vi.mock("@/lib/crosspost-retry", () => ({ retryFailedCrossposts }));
vi.mock("@/lib/fedi-retention", () => ({ pruneStaleFediPosts }));

import { startScheduler, runPublishTick, runBlueskySyncTick, runDeliveryRetryTick, runCrosspostRetryTick, runRetentionSweepTick } from "@/lib/scheduler";

const cfg = (over: Record<string, unknown> = {}) => ({
  publishScheduled: { enabled: true, intervalSec: 60 },
  blueskySync: { enabled: true, intervalSec: 900 },
  deliveryRetry: { enabled: false, intervalSec: 60 },
  crosspostRetry: { enabled: false, intervalSec: 60 },
  retentionSweep: { enabled: false, intervalSec: 86_400, retentionDays: 90 },
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
  pollBlueskyDMs.mockResolvedValue({ messages: 0 });
  syncBlueskyNotifications.mockResolvedValue({ pushed: 0 });
  retryFailedDeliveries.mockResolvedValue({ claimed: 0, delivered: 0, gaveUp: 0, pruned: 0 });
  retryFailedCrossposts.mockResolvedValue({ claimed: 0, delivered: 0, gaveUp: 0, pruned: 0 });
  pruneStaleFediPosts.mockResolvedValue({ scanned: 0, pruned: 0, filesRemoved: 0, capped: false });
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
