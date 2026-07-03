import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  getSchedulerConfig, getEffectiveSchedulerConfig,
  publishDueScheduledPosts, syncBlueskyGraph, pollBlueskyDMs, syncBlueskyNotifications,
} = vi.hoisted(() => ({
  getSchedulerConfig: vi.fn(),
  getEffectiveSchedulerConfig: vi.fn(),
  publishDueScheduledPosts: vi.fn(),
  syncBlueskyGraph: vi.fn(),
  pollBlueskyDMs: vi.fn(),
  syncBlueskyNotifications: vi.fn(),
}));
vi.mock("@/lib/scheduler-config", () => ({ getSchedulerConfig, getEffectiveSchedulerConfig }));
vi.mock("@/lib/publish-post", () => ({ publishDueScheduledPosts }));
vi.mock("@/lib/bluesky-graph", () => ({ syncBlueskyGraph }));
vi.mock("@/lib/bluesky-dm-poll", () => ({ pollBlueskyDMs }));
vi.mock("@/lib/bluesky-notifications", () => ({ syncBlueskyNotifications }));

import { startScheduler, runPublishTick, runBlueskySyncTick } from "@/lib/scheduler";

const cfg = (over: Record<string, unknown> = {}) => ({
  publishScheduled: { enabled: true, intervalSec: 60 },
  blueskySync: { enabled: true, intervalSec: 900 },
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
