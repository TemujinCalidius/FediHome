import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import os from "os";
import { mkdtemp, writeFile, mkdir, rm, chmod } from "fs/promises";

/**
 * The configurable uploads directory (#363).
 *
 * The path was hardcoded as `path.join(process.cwd(), "public", "uploads", …)`
 * at eleven separate call sites, so putting media on a bigger disk meant a
 * symlink, and user data lived inside the git working tree.
 *
 * The two properties that matter most here:
 *
 *   1. **Nothing on disk is ever moved.** Reads fall back to the legacy root, so
 *      changing the setting cannot 404 media that was uploaded before it.
 *   2. **Containment survives relocation.** The traversal guard has to work
 *      against the configured root, not just the built-in one.
 */

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { siteSetting: { findUnique } } }));

import {
  uploadsDir,
  legacyUploadsDir,
  resolveUploadPath,
  uploadPathFor,
  checkUploadsDir,
  invalidateUploadsDirCache,
} from "@/lib/uploads-dir";

let tmp: string;
const OLD_ENV = process.env.FEDIHOME_UPLOADS_DIR;

beforeEach(async () => {
  vi.clearAllMocks();
  invalidateUploadsDirCache();
  delete process.env.FEDIHOME_UPLOADS_DIR;
  findUnique.mockResolvedValue(null);
  tmp = await mkdtemp(path.join(os.tmpdir(), "fedihome-uploads-"));
});

afterAll(async () => {
  if (OLD_ENV === undefined) delete process.env.FEDIHOME_UPLOADS_DIR;
  else process.env.FEDIHOME_UPLOADS_DIR = OLD_ENV;
});

describe("precedence", () => {
  it("defaults to public/uploads inside the install", async () => {
    expect(await uploadsDir()).toBe(legacyUploadsDir());
  });

  it("uses the env var when set", async () => {
    process.env.FEDIHOME_UPLOADS_DIR = tmp;
    expect(await uploadsDir()).toBe(path.resolve(tmp));
  });

  it("lets the database setting win over the env var", async () => {
    // The admin panel is the point of the issue; env stays as the escape hatch.
    process.env.FEDIHOME_UPLOADS_DIR = "/env/path";
    findUnique.mockResolvedValue({ value: tmp });
    expect(await uploadsDir()).toBe(path.resolve(tmp));
  });

  it("ignores a relative path — it would move with the working directory", async () => {
    findUnique.mockResolvedValue({ value: "relative/uploads" });
    expect(await uploadsDir()).toBe(legacyUploadsDir());
  });

  it("never throws when the database is unreadable", async () => {
    // Failing an upload because a config read failed would be a poor trade.
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await uploadsDir()).toBe(legacyUploadsDir());
  });
});

describe("reads fall back to the legacy location — no file is ever moved", () => {
  it("serves media that predates the move, from the old root", async () => {
    // This is what makes changing the setting safe: the owner relocates at their
    // leisure, or never, and nothing 404s in the meantime.
    const legacy = legacyUploadsDir();
    await mkdir(path.join(legacy, "1999", "12"), { recursive: true });
    const old = path.join(legacy, "1999", "12", "old.jpg");
    await writeFile(old, "x");

    findUnique.mockResolvedValue({ value: tmp });
    expect(await resolveUploadPath("/uploads/1999/12/old.jpg")).toBe(old);

    await rm(path.join(legacy, "1999"), { recursive: true, force: true });
  });

  it("prefers the configured root when the file exists in both", async () => {
    await mkdir(path.join(tmp, "2026", "01"), { recursive: true });
    const fresh = path.join(tmp, "2026", "01", "a.jpg");
    await writeFile(fresh, "x");
    findUnique.mockResolvedValue({ value: tmp });
    expect(await resolveUploadPath("/uploads/2026/01/a.jpg")).toBe(fresh);
  });

  it("returns the configured path for a file that exists nowhere", async () => {
    // So a caller can report "not found" against the path they'd expect.
    findUnique.mockResolvedValue({ value: tmp });
    expect(await resolveUploadPath("/uploads/nope.jpg")).toBe(path.join(path.resolve(tmp), "nope.jpg"));
  });
});

describe("containment survives relocation", () => {
  it("refuses traversal out of the configured root", async () => {
    findUnique.mockResolvedValue({ value: tmp });
    expect(await resolveUploadPath("/uploads/../../etc/passwd")).toBeNull();
    expect(await uploadPathFor("..", "..", "etc", "passwd")).toBeNull();
  });

  it("refuses an absolute segment", async () => {
    findUnique.mockResolvedValue({ value: tmp });
    expect(await resolveUploadPath("/uploads/")).toBeNull();
  });

  it("accepts an ordinary nested path", async () => {
    findUnique.mockResolvedValue({ value: tmp });
    expect(await uploadPathFor("2026", "01", "a.jpg")).toBe(path.join(path.resolve(tmp), "2026/01/a.jpg"));
  });
});

describe("checkUploadsDir — the reason a save is refused", () => {
  it("accepts a writable directory", async () => {
    expect(await checkUploadsDir(tmp)).toEqual({ ok: true, path: path.resolve(tmp) });
  });

  it("refuses a relative path", async () => {
    const r = await checkUploadsDir("uploads");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/absolute/i);
  });

  it("refuses a directory that doesn't exist", async () => {
    const r = await checkUploadsDir(path.join(tmp, "missing"));
    expect(r.ok === false && r.error).toMatch(/doesn't exist/i);
  });

  it("refuses a file", async () => {
    const f = path.join(tmp, "afile");
    await writeFile(f, "x");
    const r = await checkUploadsDir(f);
    expect(r.ok === false && r.error).toMatch(/isn't a directory/i);
  });

  it("refuses a directory it cannot write to, by probing rather than guessing", async () => {
    // The failure being guarded against is a Docker bind mount owned by root
    // while the app runs as `node`. Permission bits alone don't answer that.
    const ro = path.join(tmp, "readonly");
    await mkdir(ro);
    await chmod(ro, 0o500);
    const r = await checkUploadsDir(ro);
    expect(r.ok === false && r.error).toMatch(/writable/i);
    await chmod(ro, 0o700);
  });

  it("refuses an empty value rather than silently doing nothing", async () => {
    expect((await checkUploadsDir("  ")).ok).toBe(false);
  });
});
