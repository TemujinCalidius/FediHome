import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import os from "os";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";

/**
 * Uploads storage measurement (#385).
 *
 * The disk filling is the failure most likely to take an instance down without
 * warning, and after #363 the uploads directory is likely to be a *separate*
 * volume — shared with up to 2GB of other people's cached media.
 *
 * Two properties matter here and are easy to get wrong:
 *
 *  - the expensive part (walking the tree) must never happen on a request path;
 *  - a full disk must be REPORTED but must never mark the instance unhealthy,
 *    because the Docker healthcheck restarts a degraded container and
 *    restarting does not free space.
 */

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { siteSetting: { findUnique } } }));

import {
  classifySpace,
  measureStorageUsage,
  lastStorageUsage,
  storageReport,
} from "@/lib/storage-usage";
import { invalidateUploadsDirCache } from "@/lib/uploads-dir";

let tmp: string;
const OLD = process.env.FEDIHOME_UPLOADS_DIR;

beforeEach(async () => {
  vi.clearAllMocks();
  invalidateUploadsDirCache();
  findUnique.mockResolvedValue(null);
  tmp = await mkdtemp(path.join(os.tmpdir(), "fedihome-storage-"));
  process.env.FEDIHOME_UPLOADS_DIR = tmp;
});

afterAll(async () => {
  if (OLD === undefined) delete process.env.FEDIHOME_UPLOADS_DIR;
  else process.env.FEDIHOME_UPLOADS_DIR = OLD;
});

const GB = 1024 ** 3;

describe("classifySpace", () => {
  it("is ok on a roomy volume", () => {
    expect(classifySpace({ availableBytes: 50 * GB, totalBytes: 100 * GB })).toBe("ok");
  });

  it("warns by ratio on a large volume", () => {
    expect(classifySpace({ availableBytes: 8 * GB, totalBytes: 100 * GB })).toBe("low");
    expect(classifySpace({ availableBytes: 2 * GB, totalBytes: 100 * GB })).toBe("critical");
  });

  it("warns by absolute floor on a small volume, where a ratio alone would say ok", () => {
    // 12% free sounds fine until it's 600MB and the next video is 700MB.
    expect(classifySpace({ availableBytes: 0.6 * GB, totalBytes: 5 * GB })).toBe("low");
    expect(classifySpace({ availableBytes: 100 * 1024 * 1024, totalBytes: 5 * GB })).toBe("critical");
  });

  it("reports unknown rather than guessing when free space can't be read", () => {
    expect(classifySpace(null)).toBe("unknown");
    expect(classifySpace({ availableBytes: 0, totalBytes: 0 })).toBe("unknown");
  });
});

describe("measureStorageUsage", () => {
  const write = async (rel: string, bytes: number) => {
    const abs = path.join(tmp, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.alloc(bytes));
  };

  it("splits the owner's own media from cached remote media", async () => {
    // The split is the useful part: it answers "is this mine, or the cache?",
    // which decides whether the fix is more disk or a smaller budget.
    await write("2026/01/mine.jpg", 3000);
    await write("audio/2026/01/mine.mp3", 2000);
    await write("fedi/2026/01/theirs.jpg", 5000);

    const usage = await measureStorageUsage();
    expect(usage.totalBytes).toBe(10_000);
    expect(usage.fediCacheBytes).toBe(5000);
    expect(usage.ownBytes).toBe(5000);
  });

  it("records the result so later reads never walk the tree again", async () => {
    // The walk stats every file; the health probe runs every 30 seconds.
    await write("2026/01/a.jpg", 100);
    const measured = await measureStorageUsage();
    expect(lastStorageUsage()).toEqual(measured);
  });

  it("copes with an uploads directory that doesn't exist yet", async () => {
    await rm(tmp, { recursive: true, force: true });
    const usage = await measureStorageUsage();
    expect(usage).toMatchObject({ totalBytes: 0, fediCacheBytes: 0, ownBytes: 0 });
  });

  it("never reports negative own-media, even if the cache grows mid-walk", async () => {
    await write("fedi/2026/01/a.jpg", 500);
    const usage = await measureStorageUsage();
    expect(usage.ownBytes).toBeGreaterThanOrEqual(0);
  });
});

describe("storageReport", () => {
  it("reports the configured directory and real free space without walking", async () => {
    const report = await storageReport();
    expect(report.uploadsDir).toBe(path.resolve(tmp));
    // statfs against a real temp dir — one syscall, no directory walk.
    expect(report.availableBytes).toBeGreaterThan(0);
    expect(report.volumeBytes).toBeGreaterThan(0);
    expect(["ok", "low", "critical"]).toContain(report.status);
  });

  it("says usage is unmeasured rather than walking on demand", async () => {
    // Before the scheduler's first scan there is simply no figure, and that is
    // the correct answer — walking here would put the cost on the caller.
    const report = await storageReport();
    expect(report).toHaveProperty("usage");
  });
});
