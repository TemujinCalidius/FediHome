import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// VAPID web-push config (#59). Prisma mocked; real secret-box crypto so the
// encrypted round-trip + env fallback are genuine. web-push is mocked so
// generate/setVapidDetails are observable without native crypto.
const { findMany, upsert, deleteMany, subDeleteMany } = vi.hoisted(() => ({
  findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), subDeleteMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    siteSetting: { findMany, upsert, deleteMany },
    pushSubscription: { deleteMany: subDeleteMany },
  },
}));
const { generateVAPIDKeys, setVapidDetails } = vi.hoisted(() => ({
  generateVAPIDKeys: vi.fn(() => ({ publicKey: "GEN_PUB", privateKey: "GEN_PRIV" })),
  setVapidDetails: vi.fn(),
}));
vi.mock("web-push", () => ({ default: { generateVAPIDKeys, setVapidDetails } }));
vi.mock("@/../site.config", () => ({ siteConfig: { contactEmail: "", fediDomain: "demo.example" } }));
vi.mock("@/lib/site-settings", () => ({ getRuntimeSiteConfig: vi.fn().mockResolvedValue({ contact: { email: "" } }) }));

import {
  getVapidConfig, getVapidPublicKey, pushConfigured, getPushKeyStatus,
  setVapidKeys, generateVapidKeys, clearVapidKeys, ensurePushConfigured, invalidatePushConfig,
} from "@/lib/push-config";
import { encryptSecret } from "@/lib/secret-box";

const PUB = "integration.push.publicKey";
const PRIV = "integration.push.privateKey";
const SUBJ = "integration.push.subject";
const rows = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

const OLD_PUB = process.env.VAPID_PUBLIC_KEY, OLD_PRIV = process.env.VAPID_PRIVATE_KEY, OLD_ADMIN = process.env.ADMIN_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_SECRET = "test-admin-secret-0123456789abcdef";
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  findMany.mockResolvedValue([]);
  upsert.mockResolvedValue({});
  deleteMany.mockResolvedValue({ count: 0 });
  subDeleteMany.mockResolvedValue({ count: 0 });
  invalidatePushConfig();
});
afterEach(() => {
  process.env.VAPID_PUBLIC_KEY = OLD_PUB; process.env.VAPID_PRIVATE_KEY = OLD_PRIV; process.env.ADMIN_SECRET = OLD_ADMIN;
  if (OLD_PUB === undefined) delete process.env.VAPID_PUBLIC_KEY;
  if (OLD_PRIV === undefined) delete process.env.VAPID_PRIVATE_KEY;
  if (OLD_ADMIN === undefined) delete process.env.ADMIN_SECRET;
});

describe("getVapidConfig / status", () => {
  it("returns null when neither DB nor env has a keypair", async () => {
    expect(await getVapidConfig()).toBeNull();
    expect(await pushConfigured()).toBe(false);
    expect((await getPushKeyStatus()).configured).toBe(false);
  });

  it("resolves the DB keypair (private decrypted), and status reports source=db without leaking the private key", async () => {
    findMany.mockResolvedValue(rows({ [PUB]: "DBPUB", [PRIV]: encryptSecret("DBPRIV")!, [SUBJ]: "mailto:me@x" }));
    expect(await getVapidConfig()).toEqual({ publicKey: "DBPUB", privateKey: "DBPRIV", subject: "mailto:me@x" });
    expect(await getVapidPublicKey()).toBe("DBPUB");
    const status = await getPushKeyStatus();
    expect(status).toEqual({ configured: true, source: "db", subject: "mailto:me@x" });
    expect(JSON.stringify(status)).not.toContain("DBPRIV"); // never exposed
  });

  it("falls back to env when no DB keypair is stored", async () => {
    findMany.mockResolvedValue([]);
    process.env.VAPID_PUBLIC_KEY = "ENVPUB"; process.env.VAPID_PRIVATE_KEY = "ENVPRIV";
    expect((await getVapidConfig())?.publicKey).toBe("ENVPUB");
    expect((await getPushKeyStatus()).source).toBe("env");
  });

  it("derives a mailto subject from the fedi domain when none is set", async () => {
    findMany.mockResolvedValue(rows({ [PUB]: "DBPUB", [PRIV]: encryptSecret("DBPRIV")! }));
    expect((await getVapidConfig())?.subject).toBe("mailto:admin@demo.example");
  });
});

describe("setVapidKeys / generate / clear — the rotation purge", () => {
  it("save encrypts the private key (never plaintext) and PURGES every subscription", async () => {
    const r = await setVapidKeys("NEWPUB", "NEWPRIV", "mailto:a@b");
    expect(r).toEqual({ ok: true });
    const privWrite = upsert.mock.calls.find((c) => c[0].where.key === PRIV)![0].create.value as string;
    expect(privWrite).toMatch(/^v1:/);
    expect(privWrite).not.toContain("NEWPRIV");
    expect(subDeleteMany).toHaveBeenCalledWith({}); // MANDATORY — old subs are bound to the old key
  });

  it("generate mints server-side, saves, purges, and returns the public key", async () => {
    const r = await generateVapidKeys();
    expect(r).toEqual({ ok: true, publicKey: "GEN_PUB" });
    expect(generateVAPIDKeys).toHaveBeenCalled();
    expect(subDeleteMany).toHaveBeenCalledWith({});
  });

  it("refuses to save without ADMIN_SECRET, and does NOT purge in that case", async () => {
    delete process.env.ADMIN_SECRET;
    const r = await setVapidKeys("P", "PRIV");
    expect(r.ok).toBe(false);
    expect(subDeleteMany).not.toHaveBeenCalled();
  });

  it("clear removes all three rows and purges subscriptions", async () => {
    await clearVapidKeys();
    expect(deleteMany).toHaveBeenCalledWith({ where: { key: { in: [PUB, PRIV, SUBJ] } } });
    expect(subDeleteMany).toHaveBeenCalledWith({});
  });
});

describe("ensurePushConfigured — process-global re-init", () => {
  it("calls setVapidDetails once for a stable key, and AGAIN after a rotation (new fingerprint)", async () => {
    findMany.mockResolvedValue(rows({ [PUB]: "PUB1", [PRIV]: encryptSecret("PRIV1")!, [SUBJ]: "mailto:a" }));
    expect(await ensurePushConfigured()).toBe(true);
    expect(await ensurePushConfigured()).toBe(true); // unchanged → no re-init
    expect(setVapidDetails).toHaveBeenCalledTimes(1);

    findMany.mockResolvedValue(rows({ [PUB]: "PUB2", [PRIV]: encryptSecret("PRIV2")!, [SUBJ]: "mailto:a" }));
    expect(await ensurePushConfigured()).toBe(true);
    expect(setVapidDetails).toHaveBeenCalledTimes(2); // rotated → re-init
    expect(setVapidDetails).toHaveBeenLastCalledWith("mailto:a", "PUB2", "PRIV2");
  });

  it("returns false and never calls setVapidDetails when unconfigured", async () => {
    findMany.mockResolvedValue([]);
    expect(await ensurePushConfigured()).toBe(false);
    expect(setVapidDetails).not.toHaveBeenCalled();
  });
});
