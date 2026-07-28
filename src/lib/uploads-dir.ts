import path from "path";
import { access, constants, mkdir, stat, unlink, writeFile } from "fs/promises";

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

export type PathCheck = { ok: true; path: string } | { ok: false; error: string };

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

  return { ok: true, path: resolved };
}
