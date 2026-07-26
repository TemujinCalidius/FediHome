import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * Detecting credentials that can no longer be decrypted (#359).
 *
 * The failure this catches is entirely silent today. `decryptSecret()` returns
 * `null` instead of throwing, so a rotated or lost `ADMIN_SECRET` means push
 * notifications stop arriving and crossposting stops happening — while the
 * admin panel still shows everything as configured. Nothing in the logs, nothing
 * in the UI.
 *
 * Easy to hit by accident: `ADMIN_SECRET` lives only in `.env.local`, so a
 * database backup doesn't contain it. Restore onto a fresh host and you're here.
 */

const { findMany, upsert } = vi.hoisted(() => ({ findMany: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { siteSetting: { findMany }, maintenanceItem: { upsert } },
}));

import { checkStoredCredentials, findUndecryptableCredentials } from "@/lib/secret-health";
import { encryptSecret } from "@/lib/secret-box";

const OLD_SECRET = process.env.ADMIN_SECRET;
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

const setSecret = (v: string | undefined) => {
  if (v === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = v;
};

/** A ciphertext produced under KEY_A, so KEY_B can't read it. */
function cipherUnderA(plaintext: string): string {
  setSecret(KEY_A);
  const t = encryptSecret(plaintext);
  if (!t) throw new Error("fixture encryption failed");
  return t;
}

beforeEach(() => {
  vi.clearAllMocks();
  setSecret(KEY_A);
  findMany.mockResolvedValue([]);
  upsert.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => setSecret(OLD_SECRET));

describe("findUndecryptableCredentials", () => {
  it("finds nothing when the key still matches", async () => {
    const ct = cipherUnderA("hunter2");
    findMany.mockResolvedValue([{ key: "integration.push.privateKey", value: ct }]);
    setSecret(KEY_A);
    expect(await findUndecryptableCredentials()).toEqual([]);
  });

  it("names each credential that can't be read after a key change", async () => {
    const push = cipherUnderA("vapid-private");
    const bsky = cipherUnderA("app-password");
    findMany.mockResolvedValue([
      { key: "integration.push.privateKey", value: push },
      { key: "integration.bluesky.password", value: bsky },
    ]);
    setSecret(KEY_B); // rotated

    const broken = await findUndecryptableCredentials();
    // Human labels, not raw setting keys — the owner has to know what to re-enter.
    expect(broken).toContain("Web Push (phone notifications)");
    expect(broken).toContain("Bluesky app password");
  });

  it("ignores values that aren't ciphertext at all", async () => {
    // A legacy plaintext row or an unrelated setting is not a key problem.
    findMany.mockResolvedValue([
      { key: "integration.bluesky.password", value: "plain-legacy-value" },
    ]);
    setSecret(KEY_B);
    expect(await findUndecryptableCredentials()).toEqual([]);
  });

  it("only inspects the four credential keys", async () => {
    await findUndecryptableCredentials();
    const where = findMany.mock.calls[0][0].where;
    expect(where.key.in).toEqual([
      "integration.push.privateKey",
      "integration.bluesky.password",
      "integration.threads.accessToken",
      "integration.tinylytics.apiKey",
    ]);
  });
});

describe("checkStoredCredentials raises the alert", () => {
  it("upserts a high-severity item naming the credentials", async () => {
    const ct = cipherUnderA("x");
    findMany.mockResolvedValue([{ key: "integration.threads.accessToken", value: ct }]);
    setSecret(KEY_B);

    await checkStoredCredentials();

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind_packageName_latest: {
            kind: "security",
            packageName: "stored-credentials",
            latest: "undecryptable",
          },
        },
        // The #310 idiom: an empty update, so a dismissed alert never returns.
        update: {},
        create: expect.objectContaining({ severity: "high" }),
      }),
    );
    const created = upsert.mock.calls[0][0].create;
    expect(created.description).toContain("Threads access token");
    expect(created.description).toContain(".env.local"); // says why a DB backup won't save you
  });

  it("says the key CHANGED when one is present", async () => {
    findMany.mockResolvedValue([{ key: "integration.push.privateKey", value: cipherUnderA("x") }]);
    setSecret(KEY_B);
    await checkStoredCredentials();
    expect(upsert.mock.calls[0][0].create.description).toContain("has changed");
  });

  it("says the key is MISSING when ADMIN_SECRET is unset", async () => {
    // Same symptom, different cause — and a different fix.
    findMany.mockResolvedValue([{ key: "integration.push.privateKey", value: cipherUnderA("x") }]);
    setSecret(undefined);
    await checkStoredCredentials();
    expect(upsert.mock.calls[0][0].create.description).toContain("isn't set");
  });

  it("raises nothing when everything decrypts", async () => {
    findMany.mockResolvedValue([{ key: "integration.push.privateKey", value: cipherUnderA("x") }]);
    setSecret(KEY_A);
    await checkStoredCredentials();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("never throws when the database is unavailable", async () => {
    // It runs at boot; a diagnostic must not be why a boot fails.
    findMany.mockRejectedValue(new Error("db down"));
    await expect(checkStoredCredentials()).resolves.toBeUndefined();
  });
});
