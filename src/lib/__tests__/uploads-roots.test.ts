import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("the consumers actually use it (#479)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const ROOT = join(__dirname, "..", "..", "..");
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("the trim sweep walks every root", () => {
    const src = read("src/lib/fedi-media.ts");
    expect(src).toContain("uploadsRoots()");
    // The single-root form is what stranded the cache in the first place.
    expect(src).not.toContain('path.join(await uploadsDir(), "fedi")');
  });

  it("the storage measurement counts every root", () => {
    const src = read("src/lib/storage-usage.ts");
    expect(src).toContain("uploadsRoots()");
    expect(src).not.toContain('const root = await uploadsDir();');
  });
});
