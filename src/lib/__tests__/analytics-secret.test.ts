import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The Tinylytics API key (#59) is a secret: stored AES-256-GCM-encrypted (real
// secret-box, key from ADMIN_SECRET), never plaintext. Prisma is mocked; the
// crypto is exercised for real so the round-trip + env fallback are genuine.
const { findUnique, upsert, deleteMany } = vi.hoisted(() => ({
  findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { siteSetting: { findUnique, upsert, deleteMany } } }));

import {
  getTinylyticsApiKey, setTinylyticsApiKey, clearTinylyticsApiKey, getAnalyticsKeyStatus,
} from "@/lib/analytics-secret";
import { encryptSecret } from "@/lib/secret-box";

const KEY = "integration.tinylytics.apiKey";
const OLD_ADMIN = process.env.ADMIN_SECRET;
const OLD_ENV = process.env.TINYLYTICS_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_SECRET = "test-admin-secret-0123456789abcdef";
  delete process.env.TINYLYTICS_API_KEY;
  findUnique.mockResolvedValue(null);
  upsert.mockResolvedValue({});
  deleteMany.mockResolvedValue({ count: 1 });
});
afterEach(() => {
  if (OLD_ADMIN === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = OLD_ADMIN;
  if (OLD_ENV === undefined) delete process.env.TINYLYTICS_API_KEY; else process.env.TINYLYTICS_API_KEY = OLD_ENV;
});

describe("analytics-secret (#59)", () => {
  it("set encrypts (never plaintext) and get decrypts round-trip", async () => {
    const r = await setTinylyticsApiKey("tly_secret_123");
    expect(r).toEqual({ ok: true });
    const stored = upsert.mock.calls[0][0].create.value as string;
    expect(stored).toMatch(/^v1:/); // encrypted envelope
    expect(stored).not.toContain("tly_secret_123"); // not stored plaintext
    findUnique.mockResolvedValue({ key: KEY, value: stored });
    expect(await getTinylyticsApiKey()).toBe("tly_secret_123");
  });

  it("falls back to the env var when no DB key is stored", async () => {
    process.env.TINYLYTICS_API_KEY = "env_key";
    expect(await getTinylyticsApiKey()).toBe("env_key");
    expect(await getAnalyticsKeyStatus()).toEqual({ configured: true, source: "env" });
  });

  it("a stored key takes precedence over env; status reports source=db", async () => {
    process.env.TINYLYTICS_API_KEY = "env_key";
    findUnique.mockResolvedValue({ value: encryptSecret("db_key")! });
    expect(await getTinylyticsApiKey()).toBe("db_key");
    expect(await getAnalyticsKeyStatus()).toEqual({ configured: true, source: "db" });
  });

  it("refuses to store without ADMIN_SECRET (encryption unavailable)", async () => {
    delete process.env.ADMIN_SECRET;
    const r = await setTinylyticsApiKey("whatever");
    expect(r.ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("clear removes the row; then get falls back to env/null", async () => {
    await clearTinylyticsApiKey();
    expect(deleteMany).toHaveBeenCalledWith({ where: { key: KEY } });
    findUnique.mockResolvedValue(null);
    expect(await getTinylyticsApiKey()).toBeNull();
    expect(await getAnalyticsKeyStatus()).toEqual({ configured: false, source: null });
  });

  it("a value that no longer decrypts (rotated ADMIN_SECRET) isn't reported configured from db", async () => {
    process.env.ADMIN_SECRET = "old-secret-value";
    const stale = encryptSecret("db_key")!;
    process.env.ADMIN_SECRET = "new-secret-value"; // rotated → stale won't decrypt
    findUnique.mockResolvedValue({ value: stale });
    expect(await getTinylyticsApiKey()).toBeNull();
    expect(await getAnalyticsKeyStatus()).toEqual({ configured: false, source: null });
  });
});
