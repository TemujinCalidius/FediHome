import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * #310 — `ensureActorKeys()` used to silently mint a fresh keypair whenever the
 * ActorKeys row was absent. Correct for a NEW instance; for an ESTABLISHED one a
 * missing row means the keys were LOST, and quietly replacing them rotates the
 * instance's federation identity with no signal at all.
 *
 * It still mints (never brick the site) but must now be impossible to miss.
 */

const { findUnique, create, settingsFindUnique, followerCount, item } = vi.hoisted(() => ({
  findUnique: vi.fn(), create: vi.fn(),
  settingsFindUnique: vi.fn(), followerCount: vi.fn(),
  // The alert goes through src/lib/maintenance now, which reads before it writes
  // so a returning fault lands as a second occurrence rather than silently (#412).
  item: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    actorKeys: { findUnique, create },
    siteSettings: { findUnique: settingsFindUnique },
    fediFollower: { count: followerCount },
    maintenanceItem: item,
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
  item.findUnique.mockResolvedValue(null);
  item.create.mockResolvedValue({});
  item.update.mockResolvedValue({});
  settingsFindUnique.mockResolvedValue({ setupDone: false });
  followerCount.mockResolvedValue(0);
});
afterEach(() => vi.restoreAllMocks());

describe("ensureActorKeys — existing keys", () => {
  it("returns the stored keypair untouched, with no side effects", async () => {
    findUnique.mockResolvedValue(KEYS);
    expect(await ensureActorKeys()).toEqual({ publicKey: "PUB", privateKey: "PRIV" });
    expect(create).not.toHaveBeenCalled();
    expect(item.create).not.toHaveBeenCalled();
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
    expect(item.create).not.toHaveBeenCalled();
  });

  it("treats a missing SiteSettings row as new, not established", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue(null);
    await ensureActorKeys();
    expect(item.create).not.toHaveBeenCalled();
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
    expect(item.create).toHaveBeenCalledTimes(1);
  });

  it("detects 'established' from followers even when setupDone is false", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: false });
    followerCount.mockResolvedValue(3); // has real followers → history exists
    await ensureActorKeys();
    expect(console.error).toHaveBeenCalled();
    expect(item.create).toHaveBeenCalled();
  });

  it("files the alert under a stable key so repeat calls don't spam", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: true });
    await ensureActorKeys();
    expect(item.create.mock.calls[0][0].data).toMatchObject({
      kind: "security",
      packageName: "federation-identity",
      latest: "actor-keys-regenerated",
      severity: "high",
    });
  });

  it("doesn't resurrect a dismissed alert on the next boot", async () => {
    // Every render path can reach this, so a dismissal has to hold.
    item.findUnique.mockResolvedValue({ dismissed: true, resolvedAt: null, occurrences: 1 });
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: true });
    await ensureActorKeys();
    expect(item.create).not.toHaveBeenCalled();
    expect(item.update).not.toHaveBeenCalled();
  });

  it("counts a SECOND identity loss rather than losing it silently", async () => {
    // Losing the keypair twice is the signature of a volume that isn't
    // persisting, which is a different and worse problem than losing it once.
    item.findUnique.mockResolvedValue({
      dismissed: true, resolvedAt: new Date("2026-06-01"), occurrences: 1,
    });
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: true });
    await ensureActorKeys();
    expect(item.update.mock.calls[0][0].data).toMatchObject({ occurrences: 2, dismissed: false });
  });

  it("is NEVER auto-resolved — it records a past event, not a current state", async () => {
    // The keypair is intact by construction one instruction after this fires, so
    // resolving on "keys are fine" would clear the alert on the next render and
    // tell the owner nothing. It clears when they dismiss it.
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: true });
    await ensureActorKeys();
    expect(item.updateMany).not.toHaveBeenCalled();

    // And with keys present it must not touch the alert at all.
    vi.clearAllMocks();
    findUnique.mockResolvedValue(KEYS);
    await ensureActorKeys();
    expect(item.updateMany).not.toHaveBeenCalled();
  });

  it("a failure while alerting never breaks key generation", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockResolvedValue({ setupDone: true });
    item.findUnique.mockRejectedValue(new Error("db down"));
    const keys = await ensureActorKeys();
    expect(keys.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("a DB failure in the establishment check falls back to silent bootstrap (never blocks a first run)", async () => {
    findUnique.mockResolvedValue(null);
    settingsFindUnique.mockRejectedValue(new Error("db down"));
    await ensureActorKeys();
    expect(create).toHaveBeenCalled();
    expect(item.create).not.toHaveBeenCalled();
  });
});
