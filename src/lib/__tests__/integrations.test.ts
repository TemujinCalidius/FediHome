import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { siteSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/secret-box";
import {
  getBlueskyCredentials,
  setBlueskyCredentials,
  clearBlueskyCredentials,
  getThreadsCredentials,
  getIntegrationStatus,
  normalizeBlueskyHandle,
} from "@/lib/integrations";

const OLD = { ...process.env };
const ENV_KEYS = ["ADMIN_SECRET", "BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD", "THREADS_USER_ID", "THREADS_ACCESS_TOKEN"];
const rows = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_SECRET = "a".repeat(64);
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  vi.mocked(prisma.siteSetting.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.siteSetting.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.siteSetting.deleteMany).mockResolvedValue({ count: 0 } as never);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (OLD[k] === undefined) delete process.env[k];
    else process.env[k] = OLD[k];
  }
});

describe("integrations — Bluesky credentials", () => {
  it("decrypts DB credentials when present", async () => {
    const enc = encryptSecret("app-pw")!;
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "integration.bluesky.handle": "me.bsky.social", "integration.bluesky.password": enc }) as never,
    );
    expect(await getBlueskyCredentials()).toEqual({ handle: "me.bsky.social", password: "app-pw" });
  });

  it("falls back to env when the DB has no row", async () => {
    process.env.BLUESKY_HANDLE = "env.bsky.social";
    process.env.BLUESKY_APP_PASSWORD = "env-pw";
    expect(await getBlueskyCredentials()).toEqual({ handle: "env.bsky.social", password: "env-pw" });
  });

  it("a saved DB credential wins over env", async () => {
    process.env.BLUESKY_HANDLE = "env.bsky.social";
    process.env.BLUESKY_APP_PASSWORD = "env-pw";
    const enc = encryptSecret("db-pw")!;
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "integration.bluesky.handle": "db.bsky.social", "integration.bluesky.password": enc }) as never,
    );
    expect(await getBlueskyCredentials()).toEqual({ handle: "db.bsky.social", password: "db-pw" });
  });

  it("returns null when neither DB nor env is configured", async () => {
    expect(await getBlueskyCredentials()).toBeNull();
  });

  it("stores the handle plain and the password ENCRYPTED (never plaintext)", async () => {
    expect(await setBlueskyCredentials("me.bsky.social", "super-secret-pw")).toEqual({ ok: true });
    const calls = vi.mocked(prisma.siteSetting.upsert).mock.calls.map(
      (c) => c[0] as { where: { key: string }; create: { value: string } },
    );
    const pw = calls.find((c) => c.where.key === "integration.bluesky.password")!;
    expect(pw.create.value).toMatch(/^v1:/);
    expect(pw.create.value).not.toContain("super-secret-pw");
    const handle = calls.find((c) => c.where.key === "integration.bluesky.handle")!;
    expect(handle.create.value).toBe("me.bsky.social");
  });

  it("refuses to save when ADMIN_SECRET is unset (no encryption available)", async () => {
    delete process.env.ADMIN_SECRET;
    const r = await setBlueskyCredentials("me", "pw");
    expect(r.ok).toBe(false);
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalled();
  });

  it("normalizes a handle (#257): strips a leading @, trims, lowercases", () => {
    expect(normalizeBlueskyHandle("@name.bsky.social")).toBe("name.bsky.social");
    expect(normalizeBlueskyHandle("  @Name.BSKY.social  ")).toBe("name.bsky.social");
    expect(normalizeBlueskyHandle("name.bsky.social")).toBe("name.bsky.social");
    expect(normalizeBlueskyHandle("@@x.example")).toBe("x.example");
  });

  it("stores the normalized handle (a pasted @handle is saved without the @)", async () => {
    await setBlueskyCredentials("@Me.bsky.social", "super-secret-pw");
    const calls = vi.mocked(prisma.siteSetting.upsert).mock.calls.map(
      (c) => c[0] as { where: { key: string }; create: { value: string } },
    );
    const handle = calls.find((c) => c.where.key === "integration.bluesky.handle")!;
    expect(handle.create.value).toBe("me.bsky.social");
  });

  // #257: every caller feeds this handle straight into agent.login(), so a raw
  // `@handle` from EITHER source fails with InvalidEmail — silently, in
  // background jobs. Normalizing only on write missed both of these.
  it("normalizes the env-fallback handle (#257) — BLUESKY_HANDLE is never normalized at write", async () => {
    process.env.BLUESKY_HANDLE = "  @Env.BSKY.social  ";
    process.env.BLUESKY_APP_PASSWORD = "env-pw";
    expect(await getBlueskyCredentials()).toEqual({ handle: "env.bsky.social", password: "env-pw" });
  });

  it("normalizes a DB handle stored raw before #258 (no migration backfills those rows)", async () => {
    const enc = encryptSecret("db-pw")!;
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "integration.bluesky.handle": "@Db.bsky.social", "integration.bluesky.password": enc }) as never,
    );
    expect(await getBlueskyCredentials()).toEqual({ handle: "db.bsky.social", password: "db-pw" });
  });

  it("reports a normalized handle in the integration status, from either source (#257)", async () => {
    process.env.BLUESKY_HANDLE = "@Env.BSKY.social";
    process.env.BLUESKY_APP_PASSWORD = "env-pw";
    expect((await getIntegrationStatus()).bluesky).toMatchObject({
      configured: true,
      handle: "env.bsky.social",
      source: "env",
    });
  });

  it("clear deletes both rows", async () => {
    await clearBlueskyCredentials();
    expect(prisma.siteSetting.deleteMany).toHaveBeenCalledWith({
      where: { key: { in: ["integration.bluesky.handle", "integration.bluesky.password"] } },
    });
  });
});

describe("integrations — status never leaks secrets", () => {
  it("reports configured + handle + source without the password", async () => {
    const enc = encryptSecret("app-pw")!;
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "integration.bluesky.handle": "me.bsky.social", "integration.bluesky.password": enc }) as never,
    );
    const s = await getIntegrationStatus();
    expect(s.bluesky).toEqual({ configured: true, handle: "me.bsky.social", source: "db" });
    const json = JSON.stringify(s);
    expect(json).not.toContain("app-pw");
    expect(json).not.toContain(enc);
  });

  it("reports source=env when only the env var is set", async () => {
    process.env.BLUESKY_HANDLE = "env.bsky.social";
    process.env.BLUESKY_APP_PASSWORD = "x";
    expect((await getIntegrationStatus()).bluesky).toEqual({ configured: true, handle: "env.bsky.social", source: "env" });
  });
});

describe("integrations — Threads", () => {
  it("decrypts DB credentials, else falls back to env", async () => {
    const enc = encryptSecret("tok")!;
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "integration.threads.userId": "123", "integration.threads.accessToken": enc }) as never,
    );
    expect(await getThreadsCredentials()).toEqual({ accessToken: "tok", userId: "123" });
  });
});
