import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * The admin password, split out from ADMIN_SECRET (#356).
 *
 * ADMIN_SECRET used to be three things at once: the password you type, the
 * session HMAC key, and the key encrypting stored credentials. That combination
 * meant you could never change your password — doing so destroyed every saved
 * credential (#359) — and choosing something memorable silently weakened
 * encryption at rest, because secret-box's fast HMAC KDF is only sound under the
 * high-entropy assumption its own comment states.
 *
 * The test that matters most here is the last one: changing the password must
 * leave ADMIN_SECRET — and therefore every stored credential — untouched.
 */

const { findUnique, upsert } = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { siteSetting: { findUnique, upsert } } }));

import {
  hashPassword,
  verifyPassword,
  validatePassword,
  setPassword,
  hasPassword,
  consumeInitialPassword,
  MIN_PASSWORD_LENGTH,
} from "@/lib/password";
import { encryptSecret, decryptSecret } from "@/lib/secret-box";

const OLD = { ADMIN_SECRET: process.env.ADMIN_SECRET, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
const setEnv = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  upsert.mockResolvedValue({});
  setEnv("ADMIN_SECRET", "a".repeat(64));
  setEnv("ADMIN_PASSWORD", undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  for (const [k, v] of Object.entries(OLD)) setEnv(k, v);
});

describe("hashing and verification", () => {
  it("round-trips a password", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same password here");
    const b = await hashPassword("same password here");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password here", a)).toBe(true);
    expect(await verifyPassword("same password here", b)).toBe(true);
  });

  it("stores parameters with the hash, so they can change later", async () => {
    const h = await hashPassword("some password value");
    expect(h.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(h.split("$")).toHaveLength(6);
  });

  it("never stores the password itself", async () => {
    const secret = "a memorable passphrase";
    const h = await hashPassword(secret);
    expect(h).not.toContain(secret);
  });

  it("treats a malformed stored hash as a failed login, not a crash", async () => {
    for (const bad of ["", "nonsense", "scrypt$x$y$z$q$r", "bcrypt$1$2$3$4$5", "scrypt$16384$8$1$$"]) {
      await expect(verifyPassword("whatever", bad)).resolves.toBe(false);
    }
  });

  it("refuses a stored hash demanding absurd memory", async () => {
    // Parameters come from the row so old hashes stay verifiable — but a hostile
    // row must not be able to ask for gigabytes.
    const hostile = `scrypt$1048576$8$1$${Buffer.from("salt").toString("base64")}$${Buffer.from("x".repeat(32)).toString("base64")}`;
    await expect(verifyPassword("whatever", hostile)).resolves.toBe(false);
  });
});

describe("validatePassword", () => {
  it("requires a reasonable minimum length", () => {
    expect(validatePassword("short")).toContain(String(MIN_PASSWORD_LENGTH));
    expect(validatePassword("x".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it("rejects non-strings and absurd lengths", () => {
    expect(validatePassword(12345)).not.toBeNull();
    expect(validatePassword(null)).not.toBeNull();
    expect(validatePassword("x".repeat(600))).not.toBeNull();
  });
});

describe("storage", () => {
  it("hasPassword reflects whether a hash row exists", async () => {
    expect(await hasPassword()).toBe(false);
    findUnique.mockResolvedValue({ value: await hashPassword("a stored password") });
    expect(await hasPassword()).toBe(true);
  });

  it("setPassword upserts the hash, never the plaintext", async () => {
    await setPassword("a brand new password");
    const written = upsert.mock.calls[0][0];
    expect(written.where).toEqual({ key: "auth.passwordHash" });
    expect(written.update.value.startsWith("scrypt$")).toBe(true);
    expect(JSON.stringify(written)).not.toContain("a brand new password");
  });
});

describe("consumeInitialPassword — scripted/hosted provisioning", () => {
  it("sets the password from ADMIN_PASSWORD when none exists", async () => {
    setEnv("ADMIN_PASSWORD", "provisioned password");
    await consumeInitialPassword();
    expect(upsert).toHaveBeenCalled();
  });

  it("does nothing when a password is already set", async () => {
    // The variable is consumed exactly once; after that the stored hash wins.
    setEnv("ADMIN_PASSWORD", "provisioned password");
    findUnique.mockResolvedValue({ value: await hashPassword("already set here") });
    await consumeInitialPassword();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("ignores a too-short ADMIN_PASSWORD rather than storing it", async () => {
    setEnv("ADMIN_PASSWORD", "short");
    await consumeInitialPassword();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does nothing when unset", async () => {
    await consumeInitialPassword();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("never throws when the database is unavailable", async () => {
    setEnv("ADMIN_PASSWORD", "provisioned password");
    findUnique.mockRejectedValue(new Error("db down"));
    upsert.mockRejectedValue(new Error("db down"));
    await expect(consumeInitialPassword()).resolves.toBeUndefined();
  });
});

describe("the whole point: rotating the password preserves stored credentials", () => {
  it("leaves ADMIN_SECRET-encrypted values readable after a password change", async () => {
    // Encrypt a credential the way the app does.
    const ciphertext = encryptSecret("bluesky-app-password");
    expect(ciphertext).not.toBeNull();

    // Change the admin password — twice, for good measure.
    await setPassword("first chosen password");
    await setPassword("second chosen password");

    // ADMIN_SECRET is untouched, so the credential still decrypts. Before the
    // split this was impossible: the password WAS the encryption key, so
    // changing it destroyed every stored credential.
    expect(decryptSecret(ciphertext!)).toBe("bluesky-app-password");
  });
});
