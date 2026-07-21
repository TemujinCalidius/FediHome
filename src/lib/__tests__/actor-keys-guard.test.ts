import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * #310 — `ensureActorKeys()` used to silently mint a fresh keypair whenever the
 * ActorKeys row was absent. Correct for a NEW instance; for an ESTABLISHED one a
 * missing row means the keys were LOST, and quietly replacing them rotates the
 * instance's federation identity with no signal at all.
 *
 * It still mints (never brick the site) but must now be impossible to miss.
 */

const { findUnique, create, settingsFindUnique, followerCount, itemUpsert } = vi.hoisted(() => ({
  findUnique: vi.fn(), create: vi.fn(),
  settingsFindUnique: vi.fn(), followerCount: vi.fn(), itemUpsert: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    actorKeys: { findUnique, create },
    siteSettings: { findUnique: settingsFindUnique },
    fediFollower: { count: followerCount },
    maintenanceItem: { upsert: itemUpsert },
  },
}));
vi.mock("@/../site.config", () => ({ siteConfig: { url: "https://demo.example", fediHandle: "me" } }));
vi.mock("@/lib/site-profile", () => ({ getRuntimeProfile: vi.fn() }));

import { ensureActorKeys } from "@/lib/federation";

const KEYS = { id: "main", publicKey: "PUB", privateKey: "PRIV" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  create.mockResolvedValue(KEYS);
  itemUpsert.mockResolvedValue({});
  settingsFindUnique.mockResolvedValue({ setupDone: false });
  followerCount.mockResolvedValue(0);
});
afterEach(() => vi.restoreAllMocks());

describe("ensureActorKeys — existing keys", () => {
  it("returns the stored keypair untouched, with no side effects", async () => {
    findUnique.mockResolvedValue(KEYS);
    expect(await ensureActorKeys()).toEqual({ publicKey: "PUB", privateKey: "PRIV" });
    expect(create).not.toHaveBeenCalled();
    expect(itemUpsert).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("ensureActorKeys — brand-new instance (correct silent bootstrap)", () => {
  it("mints quietly: no warning, no alert", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: false });
    followerCount.mockResolvedValue(0);
    await ensureActorKeys();
    expect(create).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(itemUpsert).not.toHaveBeenCalled();
  });

  it("treats a missing SiteSettings row as new, not established", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue(null);
    await ensureActorKeys();
    expect(itemUpsert).not.toHaveBeenCalled();
  });
});

describe("ensureActorKeys — ESTABLISHED instance with missing keys (#310)", () => {
  it("still mints (never bricks the site) but warns loudly AND raises an admin alert", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: true });
    const keys = await ensureActorKeys();

    // Site keeps working — a real, freshly-minted keypair comes back.
    expect(keys.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(keys.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(create).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("FEDERATION IDENTITY REGENERATED"));
    expect(itemUpsert).toHaveBeenCalledTimes(1);
  });

  it("detects 'established' from followers even when setupDone is false", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: false });
    followerCount.mockResolvedValue(3); // has real followers → history exists
    await ensureActorKeys();
    expect(console.error).toHaveBeenCalled();
    expect(itemUpsert).toHaveBeenCalled();
  });

  it("files the alert under a stable key so repeat calls don't spam, and doesn't resurrect a dismissal", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: true });
    await ensureActorKeys();
    const arg = itemUpsert.mock.calls[0][0];
    expect(arg.where.kind_packageName_latest).toEqual({
      kind: "security", packageName: "federation-identity", latest: "actor-keys-regenerated",
    });
    expect(arg.update).toEqual({}); // an already-dismissed alert stays dismissed
    expect(arg.create.severity).toBe("high");
  });

  it("a failure while alerting never breaks key generation", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: true });
    itemUpsert.mockRejectedValue(new Error("db down"));
    const keys = await ensureActorKeys();
    expect(keys.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("a DB failure in the establishment check falls back to silent bootstrap (never blocks a first run)", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockRejectedValue(new Error("db down"));
    await ensureActorKeys();
    expect(create).toHaveBeenCalled();
    expect(itemUpsert).not.toHaveBeenCalled();
  });
});
