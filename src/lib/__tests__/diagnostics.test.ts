import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * #395. An operator without shell access can't answer "what version, what
 * install shape, is the scheduler running, is the disk full" — which is most of
 * what any support conversation starts with.
 *
 * The safety property is the point of this suite. A redactor has to KNOW every
 * secret in order to remove one, and since #59 the database is the primary store
 * for every integration credential while the environment is only a fallback — so
 * a redactor built around process.env is a no-op on exactly the instances
 * configured through the admin panel. This bundle reads no secret at all, which
 * has no such failure mode.
 */
const SENTINELS = {
  ADMIN_SECRET: "SENTINEL-admin-secret-value",
  DATABASE_URL: "postgres://u:SENTINEL-db-password@h/db",
  BLUESKY_APP_PASSWORD: "abcd-efgh-ijkl-mnop",
  THREADS_ACCESS_TOKEN: "SENTINEL-threads-token",
};

const load = async () => {
  vi.resetModules();
  vi.doMock("@/lib/db", () => ({
    prisma: {
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      post: { count: vi.fn().mockResolvedValue(3) },
      fediPost: { count: vi.fn().mockResolvedValue(9) },
      fediFollower: { count: vi.fn().mockResolvedValue(2) },
      fediFollowing: { count: vi.fn().mockResolvedValue(4) },
      failedDelivery: { count: vi.fn().mockResolvedValue(0) },
      failedCrosspost: { count: vi.fn().mockResolvedValue(1) },
      maintenanceItem: { count: vi.fn().mockResolvedValue(0) },
    },
  }));
  vi.doMock("@/lib/storage-usage", () => ({
    storageReport: vi.fn().mockResolvedValue({
      uploadsDir: "/srv/up", status: "ok", availableBytes: 1234, volumeBytes: 9999,
    }),
  }));
  vi.doMock("@/lib/integrations", () => ({
    getIntegrationStatus: vi.fn().mockResolvedValue({
      bluesky: { configured: true, handle: "me.example", source: "db" },
      threads: { configured: false, userId: null, source: null },
      dayOne: { configured: false, dayOneEmail: null, host: null, port: null, user: null, source: null },
    }),
  }));
  vi.doMock("@/lib/scheduler", () => ({
    schedulerStarted: () => true,
    schedulerLastTickAgoMs: () => 4000,
  }));
  const { collectDiagnostics } = await import("@/lib/diagnostics");
  return collectDiagnostics();
};

beforeEach(() => {
  vi.resetModules();
  for (const [k, v] of Object.entries(SENTINELS)) process.env[k] = v;
});

describe("the bundle never carries a secret (#395)", () => {
  it("contains no environment VALUE, only names", async () => {
    const text = await load();
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(text, `${name} value leaked`).not.toContain(value);
      expect(text, `${name} should be listed by name`).toContain(name);
    }
  });

  it("reports set/not-set rather than the value", async () => {
    const text = await load();
    expect(text).toMatch(/ADMIN_SECRET\s+set/);
    delete process.env.THREADS_ACCESS_TOKEN;
    const text2 = await load();
    expect(text2).toMatch(/THREADS_ACCESS_TOKEN\s+not set/);
  });

  it("never prints a database connection string, even on failure", async () => {
    // A Prisma error can carry the URL, and that URL carries the password.
    vi.resetModules();
    const text = await load();
    expect(text).not.toContain("postgres://");
  });

  it("says the database is unreachable without quoting the error text", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      prisma: {
        $queryRaw: vi.fn().mockRejectedValue(new Error(`connect failed for ${SENTINELS.DATABASE_URL}`)),
        post: { count: vi.fn().mockRejectedValue(new Error("x")) },
        fediPost: { count: vi.fn().mockRejectedValue(new Error("x")) },
        fediFollower: { count: vi.fn().mockRejectedValue(new Error("x")) },
        fediFollowing: { count: vi.fn().mockRejectedValue(new Error("x")) },
        failedDelivery: { count: vi.fn().mockRejectedValue(new Error("x")) },
        failedCrosspost: { count: vi.fn().mockRejectedValue(new Error("x")) },
        maintenanceItem: { count: vi.fn().mockRejectedValue(new Error("x")) },
      },
    }));
    vi.doMock("@/lib/storage-usage", () => ({ storageReport: vi.fn().mockRejectedValue(new Error("x")) }));
    vi.doMock("@/lib/integrations", () => ({ getIntegrationStatus: vi.fn().mockRejectedValue(new Error("x")) }));
    vi.doMock("@/lib/scheduler", () => ({ schedulerStarted: () => false, schedulerLastTickAgoMs: () => null }));
    const { collectDiagnostics } = await import("@/lib/diagnostics");
    const text = await collectDiagnostics();
    expect(text).toContain("reachable");
    expect(text).not.toContain("SENTINEL-db-password");
  });

  it("degrades section by section rather than failing whole", async () => {
    // A bundle you can't generate because one subsystem is down is useless
    // exactly when it is most needed.
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      prisma: {
        $queryRaw: vi.fn().mockRejectedValue(new Error("down")),
        post: { count: vi.fn().mockRejectedValue(new Error("down")) },
        fediPost: { count: vi.fn().mockRejectedValue(new Error("down")) },
        fediFollower: { count: vi.fn().mockRejectedValue(new Error("down")) },
        fediFollowing: { count: vi.fn().mockRejectedValue(new Error("down")) },
        failedDelivery: { count: vi.fn().mockRejectedValue(new Error("down")) },
        failedCrosspost: { count: vi.fn().mockRejectedValue(new Error("down")) },
        maintenanceItem: { count: vi.fn().mockRejectedValue(new Error("down")) },
      },
    }));
    vi.doMock("@/lib/storage-usage", () => ({ storageReport: vi.fn().mockRejectedValue(new Error("down")) }));
    vi.doMock("@/lib/integrations", () => ({ getIntegrationStatus: vi.fn().mockRejectedValue(new Error("down")) }));
    vi.doMock("@/lib/scheduler", () => ({ schedulerStarted: () => false, schedulerLastTickAgoMs: () => null }));
    const { collectDiagnostics } = await import("@/lib/diagnostics");
    const text = await collectDiagnostics();
    expect(text).toContain("## Version and install");
    expect(text).toContain("## Environment (names only — no values)");
  });
});

describe("the bundle carries what a support conversation starts with", () => {
  it("reports version, install shape, scheduler and storage", async () => {
    const text = await load();
    for (const key of ["install shape", "node", "started", "last tick", "uploads dir", "available bytes"]) {
      expect(text, `missing ${key}`).toContain(key);
    }
  });

  it("reports integrations as configured-or-not, not as credentials", async () => {
    const text = await load();
    expect(text).toMatch(/bluesky\s+configured \(db\)/);
    expect(text).toMatch(/threads\s+not configured/);
  });
});

describe("the route is admin-gated and uncacheable (#395)", () => {
  const src = read("src/app/api/admin/diagnostics/route.ts");

  it("requires admin", () => {
    expect(src).toContain("verifyAdmin(req)");
    expect(src).toContain("status: 401");
  });

  it("is never cached", () => {
    // A point-in-time snapshot of one instance; a proxy holding it would be both
    // wrong and unwelcome.
    expect(src).toContain("no-store");
  });

  it("transmits nothing on its own", () => {
    // The operator gets the text and decides. No upload, no phone-home.
    expect(src).not.toMatch(/fetch\(|axios|https:\/\//);
  });
});

describe("the omission is deliberate and recorded", () => {
  it("says why there is no log tail", () => {
    // It is the most useful thing a bundle could carry and the only part that
    // can contain arbitrary strings. Making it safe needs redaction against
    // RESOLVED credentials, which is separate work.
    expect(read("src/lib/diagnostics.ts")).toMatch(/DELIBERATELY OMITTED/);
  });
});
