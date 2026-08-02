import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseFediCacheMb, MAX_FEDI_CACHE_MB, DEFAULT_FEDI_CACHE_MB } from "@/lib/uploads-dir";
import { validateSiteConfigValue } from "@/lib/site-settings";

/**
 * #364. The remote-media cache was capped at a hardcoded 2GB on the same disk as
 * the operator's own uploads, with no way to change it.
 *
 * Two of the issue's claims are stale and worth not re-fixing: the visibility
 * half shipped in #385 (storage-usage.ts already splits fediCacheBytes from
 * ownBytes and classifies free space), and the eviction is NOT LRU — it sorts on
 * mtime, and nothing in the codebase touches atime on a read.
 */
describe("parseFediCacheMb", () => {
  it("accepts a whole number of megabytes", () => {
    expect(parseFediCacheMb("2048")).toBe(2048);
    expect(parseFediCacheMb(" 512 ")).toBe(512);
  });

  it("accepts 0 — the operator turning caching off entirely", () => {
    expect(parseFediCacheMb("0")).toBe(0);
  });

  it("accepts the ceiling and rejects one past it", () => {
    expect(parseFediCacheMb(String(MAX_FEDI_CACHE_MB))).toBe(MAX_FEDI_CACHE_MB);
    expect(parseFediCacheMb(String(MAX_FEDI_CACHE_MB + 1))).toBeNull();
  });

  it("rejects junk rather than yielding NaN megabytes", () => {
    // Reached from a row that could have been written by hand or restored, so a
    // bad value must not become a budget of NaN bytes and delete the cache.
    for (const v of ["", "  ", "abc", "1.5", "-1", "1e3", null, undefined]) {
      expect(parseFediCacheMb(v as string), JSON.stringify(v)).toBeNull();
    }
  });
});

describe("the generic int cap does not apply to megabytes (#364)", () => {
  it("accepts a budget well past the 3650 day-count cap", () => {
    // THE TRAP: validateSiteConfigValue caps every `int` field at 3650 because
    // every other one is a day count. Without a per-key branch, any budget above
    // 3.5GB is rejected as invalid — including the obvious step up from 2GB.
    expect(validateSiteConfigValue("storage.fediCacheMb", "10240")).toBe("10240");
    expect(validateSiteConfigValue("storage.fediCacheMb", "51200")).toBe("51200");
  });

  it("still caps it somewhere", () => {
    expect(validateSiteConfigValue("storage.fediCacheMb", String(MAX_FEDI_CACHE_MB + 1))).toBeNull();
  });

  it("accepts 0", () => {
    expect(validateSiteConfigValue("storage.fediCacheMb", "0")).toBe("0");
  });

  it("leaves the day-count fields capped at 3650", () => {
    // The per-key branch must not become a general loosening.
    expect(validateSiteConfigValue("security.appTokenTtlDays", "3650")).toBe("3650");
    expect(validateSiteConfigValue("security.appTokenTtlDays", "3651")).toBeNull();
  });
});

describe("fediCacheBudgetBytes — precedence and failure", () => {
  const load = async (row: string | undefined, env?: string) => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      prisma: {
        siteSetting: {
          findUnique: vi.fn().mockResolvedValue(row === undefined ? null : { value: row }),
        },
      },
    }));
    if (env === undefined) delete process.env.FEDIHOME_FEDI_CACHE_MB;
    else process.env.FEDIHOME_FEDI_CACHE_MB = env;
    const mod = await import("@/lib/uploads-dir");
    mod.invalidateFediCacheBudgetCache();
    return mod;
  };
  beforeEach(() => vi.resetModules());

  it("defaults to the 2GB that used to be hardcoded", async () => {
    const { fediCacheBudgetBytes } = await load(undefined);
    expect(await fediCacheBudgetBytes()).toBe(DEFAULT_FEDI_CACHE_MB * 1024 * 1024);
  });

  it("uses the stored budget", async () => {
    const { fediCacheBudgetBytes } = await load("512");
    expect(await fediCacheBudgetBytes()).toBe(512 * 1024 * 1024);
  });

  it("lets the database beat the environment", async () => {
    const { fediCacheBudgetBytes } = await load("512", "4096");
    expect(await fediCacheBudgetBytes()).toBe(512 * 1024 * 1024);
    delete process.env.FEDIHOME_FEDI_CACHE_MB;
  });

  it("falls back rather than throwing on a junk row", async () => {
    // A bad row must not take the trim sweep or the storage panel down.
    const { fediCacheBudgetBytes } = await load("not a number");
    expect(await fediCacheBudgetBytes()).toBe(DEFAULT_FEDI_CACHE_MB * 1024 * 1024);
  });

  it("honours a stored 0 rather than treating it as unset", async () => {
    // The falsy trap: `row?.value || default` would silently ignore "0", which
    // is the one value an operator on a small disk most wants.
    const { fediCacheBudgetBytes, remoteMediaCachingEnabled } = await load("0");
    expect(await fediCacheBudgetBytes()).toBe(0);
    expect(await remoteMediaCachingEnabled()).toBe(false);
  });

  it("reports caching enabled for any positive budget", async () => {
    const { remoteMediaCachingEnabled } = await load("1");
    expect(await remoteMediaCachingEnabled()).toBe(true);
  });
});
