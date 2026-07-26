import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/**
 * Boot guards (#357, #362).
 *
 * #357 is the only failure in this set that is genuinely **unrecoverable**.
 * Without `SITE_URL`, the instance federates as `@me@localhost:3000` — silently
 * — and that address is written into the actor id, the WebFinger subject, the
 * signature keyId, and (because `Post.apId` is absolute) every post published
 * before anyone notices. Fixing the environment afterwards changes none of it:
 * remote servers keep the identity they first saw, and there's no outbound
 * `Move` yet. So this fails CLOSED: refusing to start is a two-minute fix,
 * booting wrong is not fixable at all.
 */

const { findUnique, upsert } = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { siteSettings: { findUnique, upsert } } }));

import {
  assertUsableIdentity,
  markSetupCompleteIfConfigured,
  UnusableIdentityError,
} from "@/lib/boot-checks";
import { clearIdentityOverrides } from "@/lib/identity";

const OLD = {
  NODE_ENV: process.env.NODE_ENV,
  SITE_URL: process.env.SITE_URL,
  FEDI_HANDLE: process.env.FEDI_HANDLE,
  FEDI_DOMAIN: process.env.FEDI_DOMAIN,
  ADMIN_SECRET: process.env.ADMIN_SECRET,
  FEDIHOME_ALLOW_LOCAL_IDENTITY: process.env.FEDIHOME_ALLOW_LOCAL_IDENTITY,
};

/** NODE_ENV is readonly in the Next types; tests need to drive it. */
const setEnv = (k: string, v: string | undefined) => {
  if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
  else (process.env as Record<string, string | undefined>)[k] = v;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearIdentityOverrides();
  for (const k of Object.keys(OLD)) setEnv(k, undefined);
  setEnv("NODE_ENV", "production");
  findUnique.mockResolvedValue(null);
  upsert.mockResolvedValue({});
});

afterAll(() => {
  clearIdentityOverrides();
  for (const [k, v] of Object.entries(OLD)) setEnv(k, v);
});

describe("assertUsableIdentity — refuses an unreachable production identity", () => {
  it("throws when SITE_URL is unset", async () => {
    expect(() => assertUsableIdentity()).toThrow(UnusableIdentityError);
  });

  it("names the address it would have federated as", async () => {
    setEnv("FEDI_HANDLE", "me");
    try {
      assertUsableIdentity();
      throw new Error("should have thrown");
    } catch (e) {
      // The operator needs to see the consequence, not just "misconfigured".
      expect((e as Error).message).toContain("@me@localhost:3000");
      expect((e as Error).message).toContain("SITE_URL=https://yourdomain.com");
    }
  });

  for (const bad of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://192.168.1.50",
    "http://10.0.0.5",
    "http://172.16.0.9",
    "http://169.254.1.1",
    "http://box.localhost",
  ]) {
    it(`throws for ${bad}`, () => {
      setEnv("SITE_URL", bad);
      expect(() => assertUsableIdentity()).toThrow(UnusableIdentityError);
    });
  }

  it("allows a real public address", () => {
    setEnv("SITE_URL", "https://demo.example");
    expect(() => assertUsableIdentity()).not.toThrow();
  });

  it("allows a public address on a non-default port", () => {
    setEnv("SITE_URL", "https://demo.example:8443");
    expect(() => assertUsableIdentity()).not.toThrow();
  });
});

describe("assertUsableIdentity — when it must NOT interfere", () => {
  it("does nothing outside production", () => {
    setEnv("NODE_ENV", "development");
    expect(() => assertUsableIdentity()).not.toThrow();
  });

  it("honours the explicit opt-out", () => {
    setEnv("SITE_URL", "http://localhost:3000");
    setEnv("FEDIHOME_ALLOW_LOCAL_IDENTITY", "true");
    expect(() => assertUsableIdentity()).not.toThrow();
  });

  it("only accepts a literal 'true' for the opt-out", () => {
    // A stray "false"/"0" must not silently disable a guard this consequential.
    setEnv("SITE_URL", "http://localhost:3000");
    for (const v of ["false", "0", "yes", ""]) {
      setEnv("FEDIHOME_ALLOW_LOCAL_IDENTITY", v);
      expect(() => assertUsableIdentity()).toThrow(UnusableIdentityError);
    }
  });
});

describe("markSetupCompleteIfConfigured — restores the #310 guard (#362)", () => {
  beforeEach(() => {
    setEnv("ADMIN_SECRET", "x".repeat(64));
    setEnv("SITE_URL", "https://demo.example");
  });

  it("records setup as complete on a configured headless install", async () => {
    await markSetupCompleteIfConfigured();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "main" },
        create: { id: "main", setupDone: true },
        update: { setupDone: true },
      }),
    );
  });

  it("does nothing when it's already recorded", async () => {
    findUnique.mockResolvedValue({ setupDone: true });
    await markSetupCompleteIfConfigured();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does nothing while genuinely mid-setup (no ADMIN_SECRET)", async () => {
    // The wizard hasn't run yet — claiming setup is done would be a lie, and
    // would wrongly arm the #310 alarm on a legitimately fresh instance.
    setEnv("ADMIN_SECRET", undefined);
    await markSetupCompleteIfConfigured();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does nothing without a configured SITE_URL", async () => {
    setEnv("SITE_URL", undefined);
    await markSetupCompleteIfConfigured();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("never throws when the database is unavailable", async () => {
    // A boot must not fail over a correctness nicety.
    findUnique.mockRejectedValue(new Error("db down"));
    await expect(markSetupCompleteIfConfigured()).resolves.toBeUndefined();
  });
});
