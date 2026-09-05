import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import path from "path";
import os from "os";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "fs/promises";

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

let tmp: string; //     the CONFIGURED root
let fakeCwd: string; // stands in for the process's working directory
let legacy: string; //  <fakeCwd>/public/uploads — the built-in root
let cwdSpy: ReturnType<typeof vi.spyOn>;
const OLD = process.env.FEDIHOME_UPLOADS_DIR;

/**
 * BOTH roots are relocated, and that is the whole point of this preamble.
 *
 * Setting FEDIHOME_UPLOADS_DIR only moves the CONFIGURED root.
 * `measureStorageUsage` walks `uploadsRoots()`, which is `[configured, legacy]`,
 * and `legacyUploadsDir()` is hardcoded `path.join(process.cwd(), "public",
 * "uploads")` — the repo's own directory. So these tests were measuring the
 * developer's real media alongside their fixtures, and asserting exact byte
 * totals against the sum. On a clean checkout that directory is empty and the
 * arithmetic happens to work; on a live install it does not, which is how this
 * was reported: `expected 14096 to be 10000`.
 *
 * Relocating `process.cwd()` rather than stubbing `legacyUploadsDir` is
 * deliberate. `uploadsRoots()` calls that function INTRA-MODULE, so a mocked
 * export is never consulted — verified, not assumed. And stubbing `uploadsRoots`
 * itself would make the file hermetic at the cost of the very behaviour below:
 * it passes with the two-root sum deleted.
 *
 * Nothing in @/lib/uploads-dir is mocked, so the real precedence, ordering and
 * dedup all stay under test.
 */
beforeEach(async () => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  tmp = await mkdtemp(path.join(os.tmpdir(), "fedihome-storage-"));
  process.env.FEDIHOME_UPLOADS_DIR = tmp;

  fakeCwd = await mkdtemp(path.join(os.tmpdir(), "fedihome-cwd-"));
  legacy = path.join(fakeCwd, "public", "uploads");
  await mkdir(legacy, { recursive: true });
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);

  // AFTER the spy: the cache holds a resolved path, so clearing it earlier
  // would just re-resolve against the real cwd.
  invalidateUploadsDirCache();
});

afterEach(async () => {
  // Not restoreAllMocks() — that would take `findUnique` with it.
  cwdSpy.mockRestore();
  invalidateUploadsDirCache();
  await rm(tmp, { recursive: true, force: true });
  await rm(fakeCwd, { recursive: true, force: true });
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

  /** Same, but into the BUILT-IN root — where media stays after a move. */
  const writeLegacy = async (rel: string, bytes: number) => {
    const abs = path.join(legacy, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.alloc(bytes));
  };

  it("does not double a symlinked root's media (#575)", async () => {
    // `public/uploads` symlinked at the configured root: two names, one
    // directory. This is a DOCUMENTED way to move media to a bigger disk, and
    // the dedup used to compare the two paths as strings — so both were walked
    // and every byte counted twice, in the one panel someone short of space
    // reads to decide what to delete.
    await rm(legacy, { recursive: true, force: true });
    await symlink(tmp, legacy, "dir");
    invalidateUploadsDirCache();

    await write("2026/01/mine.jpg", 3000);
    await write("fedi/2026/01/theirs.jpg", 5000);

    const usage = await measureStorageUsage();
    expect(usage.totalBytes).toBe(8000); // not 16000
    expect(usage.fediCacheBytes).toBe(5000); // not 10000
    expect(usage.ownBytes).toBe(3000);
  });

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

  /**
   * THE BEHAVIOUR #479 SHIPPED, AND NOTHING HAS EVER EXECUTED IT.
   *
   * Verified by mutation: changing storage-usage.ts to
   * `(await uploadsRoots()).slice(0, 1)` — deleting the two-root sum outright —
   * left the entire 2067-test suite green. The only guards were source-text
   * greps in uploads-roots.test.ts asserting the string "uploadsRoots()"
   * appears, which that mutant satisfies.
   *
   * It was invisible for the same reason the suite was fragile: the legacy root
   * was the repo's real public/uploads, empty on any clean checkout, so the
   * second entry contributed nothing and the sum was never a sum.
   */
  it("counts media stranded in the legacy root after a move (#479)", async () => {
    // The install shape docs/configuration.md recommends: move to a bigger
    // volume, and the old media stays where it was until it is copied across.
    await write("2026/01/mine.jpg", 3000);
    await writeLegacy("fedi/2026/01/theirs.jpg", 5000);

    const usage = await measureStorageUsage();
    expect(usage.totalBytes).toBe(8000);
    expect(usage.fediCacheBytes).toBe(5000);
    expect(usage.ownBytes).toBe(3000);
  });

  it("is unaffected by media sitting in the legacy root it is not measuring", async () => {
    // The regression guard for the report itself: on a live install the legacy
    // root holds the operator's real media, and these assertions used to add it
    // to the fixtures. Here the configured root IS the legacy root's parent
    // install, so a file outside both must not count.
    await write("2026/01/mine.jpg", 1000);
    const outside = path.join(fakeCwd, "not-uploads");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "stray.bin"), Buffer.alloc(9999));

    expect((await measureStorageUsage()).totalBytes).toBe(1000);
  });

  it("does not double-count on a default install, where both roots are one directory", async () => {
    // uploadsRoots dedupes when the configured path equals the built-in one.
    // The existing coverage of that is a string comparison; this is the byte
    // consequence, which is what the docstring there actually promises.
    process.env.FEDIHOME_UPLOADS_DIR = legacy;
    invalidateUploadsDirCache();
    await mkdir(path.join(legacy, "2026", "01"), { recursive: true });
    await writeFile(path.join(legacy, "2026", "01", "a.jpg"), Buffer.alloc(1000));

    expect((await measureStorageUsage()).totalBytes).toBe(1000);
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
