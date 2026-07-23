import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * The database overlay for federation identity (#326 Phase 1).
 *
 * Two things matter here. First, precedence: a saved identity must win over the
 * environment, or the overlay is pointless — but a MISSING row must fall through
 * to the environment rather than to a default, or an instance would silently
 * start federating as `@me@localhost:3000`.
 *
 * Second, it must never throw. This runs during boot, before anything can serve
 * a request; a database that is down or mid-migration has to leave the instance
 * on its environment identity rather than refusing to start.
 */

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { siteSetting: { findMany } } }));

import { loadIdentity, refreshIdentity, IDENTITY_KEYS } from "@/lib/identity-store";
import { getIdentity, clearIdentityOverrides } from "@/lib/identity";

const OLD = {
  SITE_URL: process.env.SITE_URL,
  FEDI_HANDLE: process.env.FEDI_HANDLE,
  FEDI_DOMAIN: process.env.FEDI_DOMAIN,
};

const rows = (o: Record<string, string>) =>
  Object.entries(o).map(([key, value]) => ({ key, value }));

beforeEach(() => {
  vi.clearAllMocks();
  clearIdentityOverrides();
  process.env.SITE_URL = "https://from-env.example";
  process.env.FEDI_HANDLE = "envhandle";
  delete process.env.FEDI_DOMAIN;
  findMany.mockResolvedValue([]);
});

afterAll(() => {
  clearIdentityOverrides();
  for (const [k, v] of Object.entries(OLD)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("loadIdentity — precedence", () => {
  it("queries exactly the identity.* keys", async () => {
    await loadIdentity();
    expect(findMany).toHaveBeenCalledWith({ where: { key: { in: IDENTITY_KEYS } } });
    expect(IDENTITY_KEYS).toEqual([
      "identity.siteUrl",
      "identity.fediHandle",
      "identity.fediDomain",
    ]);
  });

  it("a saved identity wins over the environment", async () => {
    findMany.mockResolvedValue(
      rows({ "identity.siteUrl": "https://from-db.example", "identity.fediHandle": "dbhandle" }),
    );
    await loadIdentity();

    const id = getIdentity();
    expect(id.siteUrl).toBe("https://from-db.example");
    expect(id.fediHandle).toBe("dbhandle");
    expect(id.actorId).toBe("https://from-db.example/ap/actor");
    // Derived values must follow the override, not straddle both sources.
    expect(id.keyId).toBe("https://from-db.example/ap/actor#main-key");
    expect(id.webfingerSubject).toBe("acct:dbhandle@from-db.example");
  });

  it("a field with no row falls through to the environment, not to a default", async () => {
    // The dangerous alternative: an instance quietly federating as @me@localhost.
    findMany.mockResolvedValue(rows({ "identity.siteUrl": "https://from-db.example" }));
    await loadIdentity();

    expect(getIdentity().fediHandle).toBe("envhandle");
  });

  it("no rows at all leaves the environment identity untouched", async () => {
    await loadIdentity();
    const id = getIdentity();
    expect(id.siteUrl).toBe("https://from-env.example");
    expect(id.fediHandle).toBe("envhandle");
  });

  it("normalisation still applies to a value that came from the database", async () => {
    findMany.mockResolvedValue(rows({ "identity.siteUrl": "https://from-db.example/" }));
    await loadIdentity();
    expect(getIdentity().actorId).toBe("https://from-db.example/ap/actor");
  });
});

describe("loadIdentity — rejects junk rows", () => {
  it("ignores blank and whitespace-bearing values rather than building a broken actor id", async () => {
    findMany.mockResolvedValue(
      rows({ "identity.siteUrl": "   ", "identity.fediHandle": "has space" }),
    );
    await loadIdentity();

    const id = getIdentity();
    expect(id.siteUrl).toBe("https://from-env.example");
    expect(id.fediHandle).toBe("envhandle");
  });

  it("ignores an unknown identity.* key", async () => {
    findMany.mockResolvedValue(rows({ "identity.nonsense": "x" }));
    await expect(loadIdentity()).resolves.toBeUndefined();
    expect(getIdentity().siteUrl).toBe("https://from-env.example");
  });
});

describe("loadIdentity — must not break the boot", () => {
  it("falls back to the environment when the database is unavailable", async () => {
    findMany.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(loadIdentity()).resolves.toBeUndefined();
    expect(getIdentity().siteUrl).toBe("https://from-env.example");
  });

  it("a failed reload drops a previously-loaded override rather than serving it blind", async () => {
    findMany.mockResolvedValue(rows({ "identity.siteUrl": "https://from-db.example" }));
    await loadIdentity();
    expect(getIdentity().siteUrl).toBe("https://from-db.example");

    findMany.mockRejectedValue(new Error("db went away"));
    await refreshIdentity();
    expect(getIdentity().siteUrl).toBe("https://from-env.example");
  });
});
