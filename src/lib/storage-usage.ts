import path from "path";
import { statfs } from "fs/promises";
import { readdir, stat } from "fs/promises";
import { uploadsDir } from "./uploads-dir";

/**
 * How full the uploads volume is (#385).
 *
 * `/api/health` gained build, uptime and scheduler liveness in #358, which made
 * it genuinely useful for monitoring. The one number still missing was the one
 * most likely to take an instance down without warning: how full the disk is.
 * It matters more since #363 made the uploads directory configurable, because
 * it's now likely to be a *separate* volume with its own capacity — and the
 * remote-media cache under `uploads/fedi/` competes for that same space.
 *
 * Two costs, kept apart on purpose:
 *
 *   - **Free space** is one `statfs` syscall. Cheap enough to answer on every
 *     health poll, and it's the figure that actually predicts failure.
 *   - **Usage** requires walking the tree and stat-ing every file. On a 2GB
 *     cache that's tens of thousands of syscalls, and the Docker HEALTHCHECK
 *     polls every 30 seconds — so it is measured by a scheduled job instead and
 *     read from a cache.
 *
 * The cache lives on `globalThis` for the same reason the scheduler's liveness
 * stamp does: `instrumentation.ts` reaches these modules through a *dynamic*
 * import while route handlers import them *statically*, and those resolve to
 * separate module instances. A module-level `let` would be written by the
 * scheduler's copy and read as undefined by the route's.
 */

export interface StorageUsage {
  /** Bytes under the uploads root, including the remote-media cache. */
  totalBytes: number;
  /** Bytes under `uploads/fedi/` — other people's media, not the owner's. */
  fediCacheBytes: number;
  /** Bytes the owner's own uploads account for. */
  ownBytes: number;
  measuredAt: string;
}

/** `ok` until the volume is nearly full; `critical` when uploads are about to fail. */
export type StorageStatus = "ok" | "low" | "critical" | "unknown";

const LOW_RATIO = 0.1; // under 10% free
const CRITICAL_RATIO = 0.03; // under 3% free
const LOW_FLOOR_BYTES = 1024 * 1024 * 1024; // ...or under 1GB, whichever bites first
const CRITICAL_FLOOR_BYTES = 256 * 1024 * 1024;

const globalStorage = globalThis as typeof globalThis & {
  __fedihomeStorageUsage?: StorageUsage;
};

/** The last measured usage, or null if the job hasn't run yet. */
export function lastStorageUsage(): StorageUsage | null {
  return globalStorage.__fedihomeStorageUsage ?? null;
}

/** Free and total bytes on the volume holding uploads. One syscall. */
export async function volumeSpace(): Promise<{ availableBytes: number; totalBytes: number } | null> {
  try {
    const s = await statfs(await uploadsDir());
    // bavail, not bfree: bfree includes blocks reserved for root, which an
    // unprivileged app can't actually use.
    return { availableBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/**
 * Classify free space.
 *
 * A ratio alone is wrong on a large volume (5% of 2TB is plenty) and a fixed
 * floor alone is wrong on a small one, so whichever threshold is reached first
 * wins.
 */
export function classifySpace(space: { availableBytes: number; totalBytes: number } | null): StorageStatus {
  if (!space || space.totalBytes <= 0) return "unknown";
  const ratio = space.availableBytes / space.totalBytes;
  if (ratio <= CRITICAL_RATIO || space.availableBytes <= CRITICAL_FLOOR_BYTES) return "critical";
  if (ratio <= LOW_RATIO || space.availableBytes <= LOW_FLOOR_BYTES) return "low";
  return "ok";
}

/** Recursive size sum. Mirrors fedi-media's walk; both stat every file. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await dirSize(full);
      else total += (await stat(full)).size;
    }
  } catch {
    // Not created yet, or unreadable — report what we could see.
  }
  return total;
}

/**
 * Walk the uploads tree and record the result. Expensive — call this from the
 * scheduler, never from a request handler.
 */
export async function measureStorageUsage(): Promise<StorageUsage> {
  const root = await uploadsDir();
  const total = await dirSize(root);
  const fedi = await dirSize(path.join(root, "fedi"));
  const usage: StorageUsage = {
    totalBytes: total,
    fediCacheBytes: fedi,
    // Clamped: the two walks aren't atomic, so a file cached between them could
    // otherwise produce a negative figure.
    ownBytes: Math.max(0, total - fedi),
    measuredAt: new Date().toISOString(),
  };
  globalStorage.__fedihomeStorageUsage = usage;
  return usage;
}

/** Everything the admin panel shows. Uses the cached walk; never walks itself. */
export async function storageReport(): Promise<{
  uploadsDir: string;
  status: StorageStatus;
  availableBytes: number | null;
  volumeBytes: number | null;
  usage: StorageUsage | null;
}> {
  const [dir, space] = await Promise.all([uploadsDir(), volumeSpace()]);
  return {
    uploadsDir: dir,
    status: classifySpace(space),
    availableBytes: space?.availableBytes ?? null,
    volumeBytes: space?.totalBytes ?? null,
    usage: lastStorageUsage(),
  };
}
