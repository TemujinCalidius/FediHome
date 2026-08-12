import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFediCacheMb, MAX_FEDI_CACHE_MB, DEFAULT_FEDI_CACHE_MB } from "@/lib/uploads-dir";
import { validateSiteConfigValue } from "@/lib/site-settings";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

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

/**
 * #550. Budget 0 is documented as "cache nothing" — in `.env.example`, in
 * `docs/configuration.md`, and most prominently in the admin panel, which
 * promises both halves at once: *"Images and video from posts in your feed are
 * copied here"* and *"**0** turns caching off entirely — media then loads from
 * the original server."*
 *
 * It only ever stopped images. `proxyVideo` never consulted the gate, so every
 * federated video kept being written to the uploads volume at up to 50MB each.
 *
 * Why 0 was the WORST setting rather than the safest: since #385 the hourly
 * storage scan is the only thing that trims the cache, and that scan can be
 * switched off. So the two settings an operator reaches for to minimise disk —
 * budget 0 and the scan disabled — combined into the one configuration with no
 * ceiling at all.
 *
 * These drive the real functions with the filesystem mocked, so they assert the
 * thing that matters: nothing is *written*. A source-grep would pass on a gate
 * that had been added in the wrong place.
 */
describe("budget 0 caches nothing — images AND video (#550)", () => {
  const load = async (cachingEnabled: boolean) => {
    vi.resetModules();
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const safeFetchResult = { buffer: Buffer.from("x"), contentType: "video/mp4" };

    vi.doMock("node:fs/promises", () => ({
      writeFile,
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn(),
      unlink: vi.fn(),
      access: vi.fn(),
    }));
    vi.doMock("@/lib/uploads-dir", () => ({
      uploadsRoots: async () => ["/srv/up"],
      uploadsDir: async () => "/srv/up",
      legacyUploadsDir: () => "/srv/up",
      ensureUploadDir: async () => "/srv/up/fedi/2026/08",
      resolveUploadPath: vi.fn(),
      uploadPathFor: vi.fn(),
      fediCacheBudgetBytes: async () => (cachingEnabled ? 2048 * 1024 * 1024 : 0),
      remoteMediaCachingEnabled: async () => cachingEnabled,
      MAX_FEDI_CACHE_MB: 51200,
      DEFAULT_FEDI_CACHE_MB: 2048,
    }));
    vi.doMock("@/lib/safe-fetch", () => ({
      guardedFetch: vi.fn(),
      GuardedFetchError: class extends Error {},
    }));

    const media = await import("@/lib/fedi-media");
    return { media, writeFile, safeFetchResult };
  };

  it("proxyVideo refuses at budget 0, and writes nothing", async () => {
    const { media, writeFile } = await load(false);
    expect(await media.proxyVideo("https://remote.example/clip.mp4")).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("proxyImage refuses at budget 0, and writes nothing", async () => {
    // The half that already worked. Pinned so a future refactor can't move the
    // gate off one entry point while adding it to the other.
    const { media, writeFile } = await load(false);
    expect(await media.proxyImage("https://remote.example/photo.jpg")).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("refusing means the caller falls back to the remote URL, not to nothing", async () => {
    // The documented behaviour of 0 — "media then loads from the original
    // server" — depends on callers reading null that way. processAttachments
    // does `urls.push(localPath || url)`, so the contract holds only while
    // proxyVideo returns null rather than throwing.
    const { media } = await load(false);
    await expect(media.proxyVideo("https://remote.example/clip.mp4")).resolves.toBeNull();
  });

  it("both gates read the same setting, so they cannot drift apart", () => {
    // Structural, and deliberately so: the bug was one entry point having the
    // check and the other not. A third proxy* would need it too.
    const src = read("src/lib/fedi-media.ts");
    const entryPoints = (src.match(/^export async function proxy\w+\(/gm) ?? []).length;
    const gates = (src.match(/if \(!\(await remoteMediaCachingEnabled\(\)\)\) return null;/g) ?? []).length;
    expect(gates).toBe(entryPoints);
  });
});

/**
 * #557. `output: "standalone"` is Docker-only, and the two halves of that have
 * to stay in step: `next.config.ts` gates on `FEDIHOME_STANDALONE`, and the
 * Dockerfile is the one place that sets it.
 *
 * Losing the ENV line does not fail quietly — the Dockerfile's
 * `COPY --from=builder /app/.next/standalone` errors when the directory isn't
 * there, and CI builds the Dockerfile on every PR (#552). This is the cheaper,
 * earlier signal, and it also pins the parsing: `process.env.X ? …` would make
 * `FEDIHOME_STANDALONE=false` mean ON, which is what this repo's `=true`/`=false`
 * house style in .env.example invites someone to write.
 */
describe("standalone output is opt-in, and the Dockerfile opts in (#557)", () => {
  it("next.config gates the output on the flag rather than hardcoding it", () => {
    const src = read("next.config.ts");
    expect(src).toContain('output: standaloneRequested() ? "standalone" : undefined');
    expect(src).not.toMatch(/^\s*output: "standalone",\s*$/m);
  });

  it("the flag is parsed, not tested for truthiness", () => {
    // `false` and `0` must mean off. Truthiness would make both mean on.
    const src = read("next.config.ts");
    expect(src).toContain('v !== "false" && v !== "0"');
  });

  it("the Dockerfile sets it before the build, and only in the builder stage", () => {
    const src = read("Dockerfile");
    const env = src.indexOf("ENV FEDIHOME_STANDALONE=1");
    const build = src.indexOf("RUN npm run build");
    const runner = src.indexOf("AS runner");
    expect(env).toBeGreaterThan(-1);
    expect(env).toBeLessThan(build);
    // In the builder: leaking it to the runner would be harmless but misleading,
    // since the standalone server bakes its config in and never reads it.
    expect(env).toBeLessThan(runner);
  });
});
