import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Running the update check automatically (#399).
 *
 * `scripts/check-updates.ts` and `POST /api/maintenance/check` both shipped, and
 * **neither had a caller anywhere in the tree**. So the notification bell was
 * wired to a source that only ever produced anything if the owner happened to run
 * `npm run check-updates` by hand — which no documentation asks them to. An
 * instance simply never heard about a security advisory.
 *
 * The failure mode a naive test misses is "never fires". Every other scheduler job
 * throttles purely in memory, which is fine at 60s and wrong for a daily one:
 *
 *   - seeded `Date.now()` (like the retention sweep) it NEVER fires on an instance
 *     that restarts more than once a day — and a self-hosted box restarting daily
 *     is completely ordinary;
 *   - seeded `0` (like publish) it fires on EVERY boot, against an unauthenticated
 *     GitHub API that allows 60 requests an hour per IP.
 *
 * So the schedule lives in a persisted watermark, and these tests simulate the
 * restart that the in-memory version gets wrong.
 */

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("@/lib/db", () => ({
  prisma: { siteSetting: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

import {
  LAST_CHECK_KEY,
  lastUpdateCheckAt,
  resetUpdateCheckLease,
  startUpdateCheck,
} from "@/lib/update-check";
import { prisma } from "@/lib/db";

const NOW = new Date("2026-07-30T12:00:00Z");
const DAY = 86_400;

/** A stand-in child process: an emitter with the two methods spawn's result needs. */
const fakeChild = () => Object.assign(new EventEmitter(), { unref: vi.fn() });
let child: ReturnType<typeof fakeChild>;

/** The stored watermark, as `hoursAgo` hours before NOW. */
const checkedHoursAgo = (hours: number) =>
  vi.mocked(prisma.siteSetting.findUnique).mockResolvedValue({
    key: LAST_CHECK_KEY,
    value: new Date(NOW.getTime() - hours * 3_600_000).toISOString(),
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetUpdateCheckLease();
  child = fakeChild();
  spawn.mockReturnValue(child);
  vi.mocked(prisma.siteSetting.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.siteSetting.upsert).mockResolvedValue({} as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the persisted watermark", () => {
  it("treats a never-checked instance as due", async () => {
    expect(await lastUpdateCheckAt()).toBe(0);
    expect((await startUpdateCheck({ intervalSec: DAY })).started).toBe(true);
  });

  it("FIRES on a restart when the last check is older than the interval", async () => {
    // The case the in-memory version gets wrong in the other direction: seeded
    // Date.now() at boot, a box that restarts every evening never reaches 24h of
    // uptime and so never checks at all.
    checkedHoursAgo(30);
    expect((await startUpdateCheck({ intervalSec: DAY })).started).toBe(true);
    expect(spawn).toHaveBeenCalled();
  });

  it("does NOT fire on a restart when a check ran recently", async () => {
    // And the case it gets wrong the first way: seeded 0, every boot spawns a run.
    checkedHoursAgo(3);
    const r = await startUpdateCheck({ intervalSec: DAY });
    expect(r).toEqual({ started: false, reason: "not-due" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("survives ten restarts in a day without checking twice", async () => {
    checkedHoursAgo(1);
    for (let i = 0; i < 10; i++) {
      resetUpdateCheckLease(); // a fresh process each time
      await startUpdateCheck({ intervalSec: DAY });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("records the timestamp BEFORE the child runs, not after", async () => {
    // A check that crashes half way must not be retried on a 15-second loop. A
    // day later is soon enough, and the alternative hammers a rate-limited API.
    await startUpdateCheck({ intervalSec: DAY });
    expect(prisma.siteSetting.upsert).toHaveBeenCalledWith({
      where: { key: LAST_CHECK_KEY },
      update: { value: NOW.toISOString() },
      create: { key: LAST_CHECK_KEY, value: NOW.toISOString() },
    });
  });

  it("treats an unreadable database as 'don't check', not as 'never checked'", async () => {
    // Answering 0 here would spawn a check on every boot of an instance whose
    // database is down or mid-migration.
    vi.mocked(prisma.siteSetting.findUnique).mockRejectedValue(new Error("db down") as never);
    expect(await lastUpdateCheckAt()).toBeNull();
    expect((await startUpdateCheck({ intervalSec: DAY })).started).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("treats an unparseable stored value as never checked", async () => {
    vi.mocked(prisma.siteSetting.findUnique).mockResolvedValue({
      key: LAST_CHECK_KEY,
      value: "not a date",
    } as never);
    expect(await lastUpdateCheckAt()).toBe(0);
  });

  it("still starts the check the owner asked for when the watermark write fails", async () => {
    vi.mocked(prisma.siteSetting.upsert).mockRejectedValue(new Error("db down") as never);
    expect((await startUpdateCheck({ force: true })).started).toBe(true);
  });
});

describe("force (the Check now button)", () => {
  it("ignores the interval", async () => {
    checkedHoursAgo(1);
    expect((await startUpdateCheck({ force: true })).started).toBe(true);
  });

  it("does NOT ignore the in-flight guard", async () => {
    // Otherwise N rapid clicks spawn N processes, each with its own Prisma pool
    // and its own set of GitHub calls.
    expect((await startUpdateCheck({ force: true })).started).toBe(true);
    const second = await startUpdateCheck({ force: true });
    expect(second).toEqual({ started: false, reason: "in-flight" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("lets the next one through once the child exits", async () => {
    await startUpdateCheck({ force: true });
    child.emit("exit", 0);
    expect((await startUpdateCheck({ force: true })).started).toBe(true);
  });

  it("un-wedges itself if the exit event never arrives", async () => {
    // The child is detached with stdio ignored, so a missed exit is possible — and
    // a plain boolean flag would then disable the check permanently.
    await startUpdateCheck({ force: true });
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60_000));
    expect((await startUpdateCheck({ force: true })).started).toBe(true);
  });
});

describe("a child that can't be started", () => {
  it("survives an asynchronous spawn error instead of crashing the server", async () => {
    // `spawn` reports a missing executable through an ASYNCHRONOUS 'error' event.
    // Unhandled on an EventEmitter that takes down the whole process — so an
    // install without `npx` on PATH would have been crashed by its own update
    // check. The route had no listener at all.
    await startUpdateCheck({ force: true });
    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
    // …and the lease is released, so the owner can try again.
    expect((await startUpdateCheck({ force: true })).started).toBe(true);
  });

  it("reports a synchronous spawn failure rather than throwing", async () => {
    spawn.mockImplementation(() => {
      throw new Error("EPERM");
    });
    expect(await startUpdateCheck({ force: true })).toEqual({
      started: false,
      reason: "spawn-failed",
    });
  });

  it("releases the lease after a synchronous failure", async () => {
    spawn.mockImplementationOnce(() => {
      throw new Error("EPERM");
    });
    await startUpdateCheck({ force: true });
    spawn.mockReturnValue(child);
    expect((await startUpdateCheck({ force: true })).started).toBe(true);
  });

  it("never keeps the server process alive for the child", async () => {
    await startUpdateCheck({ force: true });
    expect(child.unref).toHaveBeenCalled();
  });
});
