import path from "path";
import fsSync from "fs";
import { access, constants, mkdir, stat, unlink, writeFile } from "fs/promises";
import { isContainerised } from "./install-shape";

/**
 * Where uploaded media lives on disk (#363).
 *
 * The path used to be `path.join(process.cwd(), "public", "uploads", …)`,
 * recomputed at eleven separate call sites, so putting media on a bigger volume
 * meant a symlink — fragile across updates, and it left a directory of user data
 * inside the git working tree.
 *
 * **Only the disk root moves. Public URLs never change.** The database stores
 * `/uploads/…` *URL* paths, never disk paths, so relocating the root needs no
 * data migration at all; `src/app/uploads/[...path]/route.ts` reads files
 * explicitly and simply looks in a different place.
 *
 * **Reads fall back to the legacy location.** Changing the setting does not move
 * a single file — we will not run a long, destructive filesystem operation
 * behind a web request on data with no backup guarantee. New uploads go to the
 * new root; anything already on disk keeps serving from the old one. The owner
 * can move files at their leisure, or never.
 *
 * Precedence: database setting → `FEDIHOME_UPLOADS_DIR` → `<cwd>/public/uploads`.
 */

export const UPLOADS_DIR_KEY = "storage.uploadsDir";

/** The built-in location, and the read fallback for media uploaded before a move. */
export function legacyUploadsDir(): string {
  return path.join(process.cwd(), "public", "uploads");
}

function fromEnv(): string | null {
  const v = process.env.FEDIHOME_UPLOADS_DIR?.trim();
  return v && path.isAbsolute(v) ? path.resolve(v) : null;
}

// 60s, matching the other runtime-config caches. An upload landing in the old
// directory for up to a minute after a change is harmless — the read fallback
// finds it either way.
const CACHE_MS = 60_000;
let cache: { at: number; dir: string } | null = null;

/** Drop the cached value — call after writing the setting. */
export function invalidateUploadsDirCache(): void {
  cache = null;
}

/**
 * The directory new uploads are written to. Never throws: a database problem
 * falls back to the environment and then the built-in path, because failing an
 * upload over a config read would be a poor trade.
 */
export async function uploadsDir(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.dir;

  let dir = fromEnv() ?? legacyUploadsDir();
  try {
    // Imported lazily: this module is pulled in by scripts that have no Prisma
    // client generated, and by the media pipeline on paths where a DB round-trip
    // would otherwise be the only reason to touch the database at all.
    const { prisma } = await import("./db");
    const row = await prisma.siteSetting.findUnique({ where: { key: UPLOADS_DIR_KEY } });
    const v = row?.value?.trim();
    if (v && path.isAbsolute(v)) dir = path.resolve(v);
  } catch {
    /* env or built-in default */
  }

  cache = { at: Date.now(), dir };
  return dir;
}

/**
 * Resolve a stored `/uploads/…` URL path to a file on disk, checking the
 * configured root first and the legacy one second.
 *
 * Returns `null` when the relative path escapes either root — the containment
 * check is `path.relative`, matching `fedi-media.ts`, not a substring test.
 */
export async function resolveUploadPath(relative: string): Promise<string | null> {
  const rel = relative.replace(/^\/+/, "").replace(/^uploads\/+/, "");
  if (!rel) return null;

  const roots = [await uploadsDir(), legacyUploadsDir()];
  let firstContained: string | null = null;

  for (const root of roots) {
    const abs = path.resolve(root, rel);
    const inside = path.relative(root, abs);
    if (inside.startsWith("..") || path.isAbsolute(inside)) continue; // traversal
    if (firstContained === null) firstContained = abs;
    try {
      await access(abs, constants.R_OK);
      return abs;
    } catch {
      /* try the legacy root */
    }
  }

  // Nothing on disk: hand back the configured location anyway so callers can
  // report a sensible "not found" against the path they'd expect.
  return firstContained;
}

/** An absolute path under the configured root, or `null` if it would escape. */
export async function uploadPathFor(...segments: string[]): Promise<string | null> {
  const root = await uploadsDir();
  const abs = path.resolve(root, ...segments);
  const inside = path.relative(root, abs);
  return inside.startsWith("..") || path.isAbsolute(inside) ? null : abs;
}

/** Create a subdirectory of the configured root and return it. */
export async function ensureUploadDir(...segments: string[]): Promise<string> {
  const dir = (await uploadPathFor(...segments)) ?? path.join(await uploadsDir(), ...segments);
  await mkdir(dir, { recursive: true });
  return dir;
}

export type PathCheck =
  | { ok: true; path: string; ephemeral?: string }
  | { ok: false; error: string };

/**
 * Filesystems whose contents do not survive the container being recreated.
 * `overlay` is the container's own root; `tmpfs`/`ramfs` are memory-backed, and
 * matter because a path under a tmpfs mount IS on a mount point and would
 * otherwise pass a naive "is it mounted?" test while living in RAM.
 */
const EPHEMERAL_FS = new Set(["overlay", "overlayfs", "aufs", "tmpfs", "ramfs"]);

/**
 * Parse /proc/self/mountinfo into [mountPoint, fsType] pairs.
 *
 * Format is `id parent maj:min root MOUNTPOINT opts [optional...] - FSTYPE src`.
 * The optional fields are variable-length, which is exactly why the ` - `
 * separator exists — split on it rather than counting columns.
 */
function readMounts(): { point: string; fs: string }[] {
  const raw = fsSync.readFileSync("/proc/self/mountinfo", "utf-8");
  const out: { point: string; fs: string }[] = [];
  for (const line of raw.split("\n")) {
    const sep = line.indexOf(" - ");
    if (sep === -1) continue;
    const left = line.slice(0, sep).split(" ");
    const right = line.slice(sep + 3).split(" ");
    // mountinfo octal-escapes spaces and a few other characters in the path.
    const point = left[4]?.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    if (point && right[0]) out.push({ point, fs: right[0] });
  }
  return out;
}

/**
 * Would files written to `dir` be lost when the container is recreated (#387)?
 * Returns an explanation, or null when the path is durable / the question does
 * not apply.
 *
 * Only asked inside a container. On a normal host every path is as durable as
 * the disk under it, and `/proc/self/mountinfo` may not exist at all (macOS),
 * so this answers "no concern" rather than guessing.
 *
 * The test is which mount the path actually lands on: take the LONGEST mount
 * point that is a prefix of it, and judge that mount. A bind mount or named
 * volume gives its own entry and is durable; a path with nothing but `/` above
 * it is on the container's overlay and is not.
 *
 * Fails OPEN — any parsing or read problem returns null. A false warning on a
 * correctly-configured instance would teach operators to click through the one
 * that matters.
 */
export function ephemeralReason(dir: string): string | null {
  try {
    if (!isContainerised()) return null;
    const target = path.resolve(dir);
    let best: { point: string; fs: string } | null = null;
    for (const m of readMounts()) {
      const rel = path.relative(m.point, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // not an ancestor
      if (!best || m.point.length > best.point.length) best = m;
    }
    if (!best) return null;
    if (!EPHEMERAL_FS.has(best.fs.toLowerCase())) return null;

    return best.point === "/"
      ? "Nothing between this directory and the container root is a mounted volume, so it lives on the container's own filesystem. Files written here are deleted when the container is recreated — which `docker compose up --build` does routinely."
      : `This directory is on a ${best.fs} mount (${best.point}), which is held in memory. Files written here are lost when the container stops.`;
  } catch {
    return null;
  }
}

/**
 * Validate an operator-supplied directory before we agree to store media in it.
 *
 * Nothing else in the codebase validates a filesystem path — `url-guard.ts` is
 * an SSRF guard and answers a different question. Writability is *probed*, not
 * inferred from permission bits, because the failure this is guarding against is
 * mundane and specific: a Docker bind mount owned by root that the `node` user
 * cannot write to, which would otherwise surface as every upload failing.
 */
export async function checkUploadsDir(input: string): Promise<PathCheck> {
  const p = input.trim();
  if (!p) return { ok: false, error: "Enter a directory, or clear the field to use the default." };
  if (!path.isAbsolute(p)) {
    return { ok: false, error: "Use an absolute path, starting with / — a relative one moves with the working directory." };
  }

  const resolved = path.resolve(p);
  try {
    const s = await stat(resolved);
    if (!s.isDirectory()) return { ok: false, error: "That path exists but isn't a directory." };
  } catch {
    return { ok: false, error: "That directory doesn't exist. Create it first, then save." };
  }

  const probe = path.join(resolved, `.fedihome-write-test-${process.pid}`);
  try {
    await writeFile(probe, "");
    await unlink(probe);
  } catch {
    return {
      ok: false,
      error: "That directory isn't writable by FediHome. Check its owner and permissions (in Docker, the app runs as the 'node' user).",
    };
  }

  // Writable is not the same question as durable (#387). A container path can
  // pass every check above and still be deleted on the next rebuild, and the
  // read fallback actively HIDES that until it is far too late — old uploads
  // keep serving from the legacy root, so the loss looks like a bug in one
  // specific upload rather than what it is. Reported, not refused: the operator
  // may genuinely mean it, and only they know their deployment.
  const ephemeral = ephemeralReason(resolved);
  return ephemeral ? { ok: true, path: resolved, ephemeral } : { ok: true, path: resolved };
}

/* ------------------ Remote-media cache budget (#364) ------------------ */

export const FEDI_CACHE_MB_KEY = "storage.fediCacheMb";

/** Unchanged behaviour on upgrade: the 2GB that used to be hardcoded. */
export const DEFAULT_FEDI_CACHE_MB = 2048;

/** 1TB. A ceiling against a fat-fingered value, not a policy. */
export const MAX_FEDI_CACHE_MB = 1_048_576;

/**
 * Parse a stored or operator-supplied budget in megabytes.
 *
 * One parser for both the write path (validation) and the read path (a
 * defensive re-parse of a row that could have been written by hand or restored
 * from a backup) — the same belt-and-braces shape the AT Protocol service URL
 * uses. `0` is valid and means "don't cache remote media at all".
 */
export function parseFediCacheMb(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim();
  // Plain decimal digits only. Number() would happily accept "1e3", "0x400" and
  // "+5" — all of which mean something, none of which anyone typed on purpose
  // into a settings field, and each of which round-trips back as a different
  // string than was stored.
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isInteger(n) && n <= MAX_FEDI_CACHE_MB ? n : null;
}

// Mirrors the uploads-dir cache: the trim sweep and the storage panel both ask
// for this, and a database round-trip per cached image would be absurd.
const BUDGET_CACHE_MS = 60_000;
let budgetCache: { at: number; bytes: number } | null = null;

/** Drop the cached budget — call after writing the setting. */
export function invalidateFediCacheBudgetCache(): void {
  budgetCache = null;
}

/**
 * The remote-media cache budget in bytes.
 *
 * Precedence matches every other storage setting: database row → environment →
 * built-in default. Never throws: a bad row falls through rather than taking the
 * trim sweep or the storage panel down with it.
 */
export async function fediCacheBudgetBytes(): Promise<number> {
  if (budgetCache && Date.now() - budgetCache.at < BUDGET_CACHE_MS) return budgetCache.bytes;

  let mb = parseFediCacheMb(process.env.FEDIHOME_FEDI_CACHE_MB) ?? DEFAULT_FEDI_CACHE_MB;
  try {
    const { prisma } = await import("./db");
    const row = await prisma.siteSetting.findUnique({ where: { key: FEDI_CACHE_MB_KEY } });
    const parsed = parseFediCacheMb(row?.value);
    if (parsed !== null) mb = parsed;
  } catch {
    /* env or built-in default */
  }

  const bytes = mb * 1024 * 1024;
  budgetCache = { at: Date.now(), bytes };
  return bytes;
}

/** False when the operator has set the budget to 0 — cache nothing. */
export async function remoteMediaCachingEnabled(): Promise<boolean> {
  return (await fediCacheBudgetBytes()) > 0;
}
