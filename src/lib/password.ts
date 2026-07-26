import crypto from "crypto";
import { prisma } from "./db";

/**
 * The admin password — separate from `ADMIN_SECRET` (#356).
 *
 * `ADMIN_SECRET` used to do three incompatible jobs at once: the password you
 * type, the session HMAC key, and the key that encrypts stored credentials.
 * That combination meant you could never change your password, because changing
 * it destroyed every saved credential (#359) — and choosing something memorable
 * silently weakened encryption at rest, since `secret-box`'s fast HMAC KDF is
 * only sound under the high-entropy assumption its comment states.
 *
 * So the roles split, and the split is deliberately ASYMMETRIC:
 *
 *   ADMIN_SECRET  stays exactly as it is — the high-entropy root for session
 *                 HMAC and secret-box encryption, and the "setup complete"
 *                 sentinel `proxy.ts` keys on. It stops being something a human
 *                 types, and stops needing to change.
 *   password      new, scrypt-hashed, stored in the database, rotatable freely.
 *
 * **What is deliberately NOT changed:** `secret-box`'s key derivation. It would
 * be tidier to move it onto HKDF with proper domain separation — but the
 * derivation IS the key, so changing it would make every existing install's
 * stored credentials undecryptable. That is precisely the bug being fixed. The
 * tidier KDF isn't worth reproducing the fault it's meant to prevent.
 *
 * scrypt because it's in Node's standard library — the project has no password
 * hashing dependency, and adding one for this would be a poor trade.
 */

const PASSWORD_KEY = "auth.passwordHash";

// N=16384, r=8, p=1 — the usual interactive baseline. Memory is 128*N*r ≈ 16MB,
// comfortably inside Node's default 32MB maxmem.
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

export const MIN_PASSWORD_LENGTH = 12;

/** `scrypt$N$r$p$salt$hash`, all base64. Self-describing so params can change. */
function format(salt: Buffer, hash: Buffer): string {
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function scrypt(password: string, salt: Buffer, keyLen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hash a password for storage. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P });
  return format(salt, hash);
}

/**
 * Verify a password against a stored hash. Constant-time, and never throws —
 * a malformed stored value is a failed login, not a 500.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (salt.length === 0 || expected.length === 0) return false;

    // Params come from the stored hash so older hashes stay verifiable, but a
    // hostile row must not be able to demand gigabytes of memory.
    const memory = 128 * n * r;
    if (memory > 64 * 1024 * 1024) return false;

    const actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: memory * 2 });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** The stored password hash, or null when none has been set yet. */
export async function getPasswordHash(): Promise<string | null> {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: PASSWORD_KEY } });
    return row?.value || null;
  } catch {
    return null;
  }
}

/** True when a real password has been set (as opposed to the ADMIN_SECRET fallback). */
export async function hasPassword(): Promise<boolean> {
  return (await getPasswordHash()) !== null;
}

/** Validation shared by every path that accepts a new password. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") return "Password must be text.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 512) return "That password is too long.";
  return null;
}

/**
 * Set (or replace) the admin password.
 *
 * Note what this does NOT touch: `ADMIN_SECRET`. That's the entire point — the
 * password can now be rotated as often as you like without making a single
 * stored credential unreadable.
 */
export async function setPassword(password: string): Promise<void> {
  const hash = await hashPassword(password);
  await prisma.siteSetting.upsert({
    where: { key: PASSWORD_KEY },
    update: { value: hash },
    create: { key: PASSWORD_KEY, value: hash },
  });
}

/**
 * Consume `ADMIN_PASSWORD` once, at first boot, if one is set and no password
 * exists yet.
 *
 * Scripted and hosted provisioning needs a way to set the password without
 * first logging in — otherwise the operator has to read a 64-character hex
 * string off disk just to sign in, which is what `install.sh` leaves them doing
 * today. The variable is read exactly once and never again; after that the
 * stored hash is authoritative, so it can be removed from the environment.
 *
 * Never throws — it runs at boot.
 */
export async function consumeInitialPassword(): Promise<void> {
  const initial = process.env.ADMIN_PASSWORD;
  if (!initial) return;
  try {
    if (await hasPassword()) return; // already set — the env var is now inert
    if (validatePassword(initial) !== null) {
      console.warn(
        `[FediHome] ADMIN_PASSWORD is set but too short (minimum ${MIN_PASSWORD_LENGTH} characters) — ignoring it.`,
      );
      return;
    }
    await setPassword(initial);
    console.warn(
      "[FediHome] Admin password set from ADMIN_PASSWORD. You can remove it from the environment now — " +
        "the stored password is what counts from here.",
    );
  } catch {
    /* a boot must not fail over this */
  }
}
