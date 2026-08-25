import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * #479. `resolveUploadPath` has always read from the configured root AND the
 * legacy one, because changing the setting deliberately moves no files. But the
 * trim sweep and the storage measurement each walked only the CURRENT root, so
 * after an operator moved the uploads directory the old cache was still served,
 * never reclaimed, and never counted.
 *
 * The worst category to strand: other people's media, in a folder the operator
 * doesn't browse, with the panel reporting a smaller figure than what's on disk.
 */
const load = async (configured: string) => {
  vi.resetModules();
  vi.doMock("@/lib/db", () => ({
    prisma: {
      siteSetting: {
        findUnique: vi.fn().mockResolvedValue(
          configured ? { value: configured } : null,
        ),
      },
    },
  }));
  const mod = await import("@/lib/uploads-dir");
  mod.invalidateUploadsDirCache();
  return mod;
};

beforeEach(() => vi.resetModules());

describe("uploadsRoots", () => {
  it("returns both roots once the directory has been moved", async () => {
    const { uploadsRoots, legacyUploadsDir } = await load("/mnt/media/uploads");
    const roots = await uploadsRoots();
    expect(roots).toHaveLength(2);
    expect(roots[0]).toBe("/mnt/media/uploads");
    expect(roots[1]).toBe(legacyUploadsDir());
  });

  it("puts the CONFIGURED root first", async () => {
    // Order matters for resolveUploadPath's read preference, and callers that
    // report a single 'where am I writing' figure take the first.
    const { uploadsRoots } = await load("/mnt/media/uploads");
    expect((await uploadsRoots())[0]).toBe("/mnt/media/uploads");
  });

  it("deduplicates on a default install", async () => {
    // The legacy root IS the configured root when nothing was set. Walking it
    // twice would double every byte the panel reports.
    const { uploadsRoots, legacyUploadsDir } = await load("");
    expect(await uploadsRoots()).toEqual([legacyUploadsDir()]);
  });

  it("deduplicates when the setting names the legacy path explicitly", async () => {
    // An operator can type the default path into the field; that must not
    // suddenly double the reported usage.
    const { legacyUploadsDir } = await load("");
    const legacy = legacyUploadsDir();
    const { uploadsRoots } = await load(legacy);
    expect(await uploadsRoots()).toEqual([legacy]);
  });
});

/**
 * #575 — two names for one directory.
 *
 * The dedup above compares the two roots as STRINGS, and the docstring on
 * `uploadsRoots` already stated the stake: "walking it twice would double every
 * byte reported". String equality does not decide "same directory". Symlink
 * `public/uploads` at a bigger disk and also point `FEDIHOME_UPLOADS_DIR` at
 * that disk — a documented way to move media, and the obvious move for someone
 * short of space — and the names differ while the directory is one.
 *
 * These use a REAL symlink and REAL nesting on disk. The tests above never
 * touched a filesystem at all, which is why this survived.
 */
describe("uploadsRoots — aliased and nested roots (#575)", () => {
  let fakeCwd: string;
  let legacy: string;
  let target: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // A stand-in working directory, so the legacy root is never the repo's own
    // `public/uploads` — writing there is what poisoned a real machine in #574.
    fakeCwd = await mkdtemp(path.join(os.tmpdir(), "fedihome-roots-cwd-"));
    target = await mkdtemp(path.join(os.tmpdir(), "fedihome-roots-target-"));
    legacy = path.join(fakeCwd, "public", "uploads");
    await mkdir(path.dirname(legacy), { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await rm(fakeCwd, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  it("counts a symlinked root once, not twice", async () => {
    // public/uploads -> /tmp/…/target, and the setting names the target. Two
    // different strings; one directory.
    await symlink(target, legacy, "dir");
    const { uploadsRoots } = await load(target);
    expect(await uploadsRoots()).toEqual([target]);
  });

  it("counts a symlinked root once when the SETTING is the symlink", async () => {
    // Naming the link itself is already caught by the plain string comparison,
    // so this one passes with or without realpath. Kept as the control: it pins
    // that the fix did not break the case that always worked.
    await symlink(target, legacy, "dir");
    const { uploadsRoots } = await load(legacy);
    expect(await uploadsRoots()).toEqual([legacy]);
  });

  it("walks only the outer root when the legacy one is nested inside it", async () => {
    // Everything under the inner root is already reached by walking the outer,
    // so returning both counts all of it twice.
    await mkdir(legacy, { recursive: true });
    const outer = fakeCwd;
    const { uploadsRoots } = await load(outer);
    expect(await uploadsRoots()).toEqual([outer]);
  });

  it("walks only the outer root when the configured one is nested inside the legacy", async () => {
    const inner = path.join(legacy, "media");
    await mkdir(inner, { recursive: true });
    const { uploadsRoots } = await load(inner);
    expect(await uploadsRoots()).toEqual([legacy]);
  });

  it("still returns both when they are genuinely different directories", async () => {
    // The fix must not collapse the case #479 exists for.
    await mkdir(legacy, { recursive: true });
    const { uploadsRoots } = await load(target);
    expect(await uploadsRoots()).toEqual([target, legacy]);
  });

  it("does not treat a sibling with a shared prefix as nested", async () => {
    // `path.relative`, not a substring test: "/a/uploads-old" is not inside
    // "/a/uploads", and a startsWith check would say it is.
    const sibling = `${legacy}-old`;
    await mkdir(legacy, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const { uploadsRoots } = await load(sibling);
    expect(await uploadsRoots()).toEqual([sibling, legacy]);
  });
});

/**
 * The cache accounting is a DIFFERENT list, and the nested case is why (#575).
 *
 * `<inner>/fedi` is not inside `<outer>/fedi`, so dropping the inner root here
 * — correct for the total — would silently reclassify somebody else's cached
 * media as the owner's own.
 */
describe("uploadsFediDirs (#575)", () => {
  let fakeCwd: string;
  let legacy: string;
  let target: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fakeCwd = await mkdtemp(path.join(os.tmpdir(), "fedihome-fedi-cwd-"));
    target = await mkdtemp(path.join(os.tmpdir(), "fedihome-fedi-target-"));
    legacy = path.join(fakeCwd, "public", "uploads");
    await mkdir(path.dirname(legacy), { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await rm(fakeCwd, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  it("keeps BOTH cache directories when one root is nested in the other", async () => {
    await mkdir(legacy, { recursive: true });
    const { uploadsRoots, uploadsFediDirs } = await load(fakeCwd);
    // The total walks the outer only...
    expect(await uploadsRoots()).toEqual([fakeCwd]);
    // ...but both caches are still accounted, or the inner one becomes "yours".
    expect(await uploadsFediDirs()).toEqual([
      path.join(fakeCwd, "fedi"),
      path.join(legacy, "fedi"),
    ]);
  });

  it("collapses an aliased root to one cache directory", async () => {
    await symlink(target, legacy, "dir");
    const { uploadsFediDirs } = await load(target);
    expect(await uploadsFediDirs()).toEqual([path.join(target, "fedi")]);
  });
});

describe("the consumers actually use it (#479)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const ROOT = join(__dirname, "..", "..", "..");
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("the trim sweep walks every root", () => {
    // Asserting the CALL, not the string (#575). These greps used to accept
    // `uploadsRoots()` appearing anywhere in the file — including inside a
    // comment, which is exactly what happened when this moved to
    // `uploadsFediDirs()`. A guard satisfied by prose is not a guard.
    const src = read("src/lib/fedi-media.ts");
    expect(src).toMatch(/await uploadsFediDirs\(\)/);
    // The single-root form is what stranded the cache in the first place.
    expect(src).not.toContain('path.join(await uploadsDir(), "fedi")');
  });

  it("the storage measurement counts every root", () => {
    const src = read("src/lib/storage-usage.ts");
    expect(src).toMatch(/await uploadsRoots\(\)/);
    expect(src).toMatch(/await uploadsFediDirs\(\)/);
    expect(src).not.toContain('const root = await uploadsDir();');
  });
});
