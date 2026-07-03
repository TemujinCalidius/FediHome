import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getSchedulerConfig, publishDueScheduledPosts, syncBlueskyGraph, pollBlueskyDMs, syncBlueskyNotifications } =
  vi.hoisted(() => ({
    getSchedulerConfig: vi.fn(),
    publishDueScheduledPosts: vi.fn(),
    syncBlueskyGraph: vi.fn(),
    pollBlueskyDMs: vi.fn(),
    syncBlueskyNotifications: vi.fn(),
  }));
vi.mock("@/lib/scheduler-config", () => ({ getSchedulerConfig }));
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
  publishDueScheduledPosts.mockResolvedValue(0);
  syncBlueskyGraph.mockResolvedValue({ followers: 1, following: 2 });
  pollBlueskyDMs.mockResolvedValue({ messages: 0 });
  syncBlueskyNotifications.mockResolvedValue({ pushed: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("in-app scheduler (#183)", () => {
  it("is idempotent per process — a second start is a no-op", async () => {
    expect(startScheduler()).toBe(true);
    expect(startScheduler()).toBe(false);
    // Only one set of intervals: one immediate publish sweep, then one per minute.
    // (async timer API so the startup tick completes — and releases the
    // in-flight guard — before the interval fires)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(2); // startup + 1 tick
  });

  it("runs the publish sweep immediately at startup, then on its interval", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(3);
  });

  it("runs the Bluesky sync on its own (longer) cadence", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(899_000);
    expect(syncBlueskyGraph).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(syncBlueskyGraph).toHaveBeenCalledTimes(1);
    expect(pollBlueskyDMs).toHaveBeenCalledTimes(1);
    expect(syncBlueskyNotifications).toHaveBeenCalledTimes(1);
  });

  it("re-checks the enabled flag every tick (toggle without restart)", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(2);
    getSchedulerConfig.mockReturnValue(cfg({ publishScheduled: { enabled: false, intervalSec: 60 } }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publishDueScheduledPosts).toHaveBeenCalledTimes(2); // no more runs
  });

  it("a disabled bluesky job never runs its sync", async () => {
    getSchedulerConfig.mockReturnValue(cfg({ blueskySync: { enabled: false, intervalSec: 900 } }));
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
