import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

/**
 * A credential that exists ONLY in the database, with nothing in `process.env`
 * (#490). This is the sentinel an env-based redactor cannot see — the shape of a
 * real Bluesky app password, on the documented configuration path.
 */
const DB_ONLY = "wxyz-1234-abcd-5678";

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
    // The resolvers the log-tail redactor calls (#490). Answering from the
    // DATABASE with the environment empty is the whole point — see DB_ONLY.
    getBlueskyCredentials: vi.fn().mockResolvedValue({ handle: "me.example", password: DB_ONLY }),
    getThreadsCredentials: vi.fn().mockResolvedValue(null),
    getDayOneCredentials: vi.fn().mockResolvedValue(null),
  }));
  vi.doMock("@/lib/push-config", () => ({ getVapidConfig: vi.fn().mockResolvedValue(null) }));
  vi.doMock("@/lib/analytics-secret", () => ({ getTinylyticsApiKey: vi.fn().mockResolvedValue(null) }));
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
    // Every credential resolver down too (#490) — the redaction refresh must
    // survive that, and the bundle must still be emitted.
    vi.doMock("@/lib/integrations", () => ({
      getIntegrationStatus: vi.fn().mockRejectedValue(new Error("x")),
      getBlueskyCredentials: vi.fn().mockRejectedValue(new Error("x")),
      getThreadsCredentials: vi.fn().mockRejectedValue(new Error("x")),
      getDayOneCredentials: vi.fn().mockRejectedValue(new Error("x")),
    }));
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
    vi.doMock("@/lib/integrations", () => ({
      getIntegrationStatus: vi.fn().mockRejectedValue(new Error("down")),
      getBlueskyCredentials: vi.fn().mockRejectedValue(new Error("down")),
      getThreadsCredentials: vi.fn().mockRejectedValue(new Error("down")),
      getDayOneCredentials: vi.fn().mockRejectedValue(new Error("down")),
    }));
    vi.doMock("@/lib/scheduler", () => ({ schedulerStarted: () => false, schedulerLastTickAgoMs: () => null }));
    const { collectDiagnostics } = await import("@/lib/diagnostics");
    const text = await collectDiagnostics();
    expect(text).toContain("## Version and install");
    expect(text).toContain("## Environment (names only — no values)");
  });
});

describe("the log tail cannot carry a DB-stored credential (#490)", () => {
  it("redacts a credential that exists ONLY in the database", async () => {
    // THE test the issue asks for, end to end. `process.env` has no Bluesky
    // password here — the credential lives only in the DB, which is the
    // documented configuration path. An env-based redactor scrubs nothing and
    // this assertion is the one that catches it.
    delete process.env.BLUESKY_APP_PASSWORD;
    vi.resetModules();
    const { recordLine, resetLogBuffer, setSecrets, REDACTED } = await import("@/lib/log-buffer");
    resetLogBuffer();
    // Capture-time redaction deliberately DISARMED, so this proves the bundle's
    // own final pass — not the buffer's. The two defences are independent and
    // the second is the one a future section relies on.
    setSecrets([]);
    recordLine("error", `bsky agent cache: https://bsky.social|me.example:${DB_ONLY}`);

    const text = await load();
    expect(text, "the DB-only credential reached the bundle").not.toContain(DB_ONLY);
    expect(text).toContain(REDACTED);
  });

  it("includes the tail, and says so when the boot hook never ran", async () => {
    vi.resetModules();
    const { resetLogBuffer } = await import("@/lib/log-buffer");
    resetLogBuffer();
    delete (globalThis as { __fedihomeLogTeeInstalled?: boolean }).__fedihomeLogTeeInstalled;
    const text = await load();
    expect(text).toContain("## Recent log");
    // Distinguishable from "nothing has been logged" — the tee is installed by
    // instrumentation.ts, so its absence means the boot hook didn't run, which
    // is itself worth knowing since the scheduler starts from the same place.
    expect(text).toContain("the boot hook didn't run");
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

describe("the log tail carries its own rule with it (#490)", () => {
  // The tail was deliberately absent when the bundle shipped (#395), because it
  // is the one part that can contain arbitrary strings. It is in now, and these
  // pin the two things that make that safe. Behaviour is covered in
  // log-buffer.test.ts; this is the wiring.
  const src = read("src/lib/diagnostics.ts");

  it("redacts the WHOLE assembled bundle, as the last thing it does", () => {
    // Per-section redaction would mean a section added later has to remember the
    // rule. One pass over the finished string means it doesn't.
    expect(src).toMatch(/return redactSecrets\(text, secrets\);/);
    const body = src.slice(src.indexOf("export async function collectDiagnostics"));
    expect(body.trimEnd().endsWith("return redactSecrets(text, secrets);\n}")).toBe(true);
  });

  it("re-resolves the credentials rather than trusting the capture snapshot", () => {
    // A credential changed since boot is not in the capture snapshot. And
    // resolveSecrets reads the DATABASE, which is the whole point — an
    // env-derived set is a no-op on an admin-panel-configured instance.
    expect(src).toContain("await resolveSecrets()");
    expect(src).not.toMatch(/currentSecrets\(\)/);
  });
});

/**
 * #511. The bundle lists the environment variables FediHome reads, by name. One
 * of them was `TRUST_PROXY`, and every actual reader uses `TRUSTED_PROXY` —
 * `client-ip.ts` for the rate-limit key and `auth.ts` for the same-origin check.
 *
 * So the bundle reported `TRUST_PROXY   not set` on every instance, including
 * ones correctly configured with `TRUSTED_PROXY=true`. That is worse than
 * useless in the one document an operator pastes into a bug report: it invites
 * both of us to chase a variable that isn't the one in play.
 *
 * Nothing pinned the list to reality — the existing tests here check that names
 * appear and values never do, which a typo passes happily. Same structural-test
 * idiom as `settings-screen-coverage`, `ssrf-call-sites` and `admin-map`: state
 * the property once, and a name nobody reads fails on the next run.
 */
describe("#511 — every name in the bundle is a variable something actually reads", () => {
  const diag = read("src/lib/diagnostics.ts");
  const names = [...diag.matchAll(/^\s*"([A-Z][A-Z0-9_]*)",$/gm)].map((m) => m[1]);

  /**
   * Read by the runtime rather than by `src/` — `NODE_ENV` and `PORT` are set
   * for Node and Next, not looked up by our code, but an operator debugging a
   * deployment wants to see them.
   */
  const RUNTIME_OWNED = new Set(["NODE_ENV", "PORT"]);

  it("found the list at all", () => {
    // Guards the regex above: if the array's formatting changes this silently
    // matches nothing, and every assertion below passes vacuously.
    expect(names.length).toBeGreaterThan(15);
    expect(names).toContain("DATABASE_URL");
  });

  it.each(names.filter((n) => !RUNTIME_OWNED.has(n)))(
    "%s is read somewhere in src/",
    (name) => {
      // `git grep` rather than a manual walk: it honours .gitignore, so the
      // generated Prisma client and .next can't produce a false positive.
      const hits = execFileSync(
        "git",
        // site.config.ts is at the repo ROOT, not under src/ — it reads the
        // TTL vars, and scoping to src/scripts alone reports them as dead.
        ["grep", "-l", "--", `process.env.${name}`, "src", "scripts", "site.config.ts"],
        { encoding: "utf-8", cwd: process.cwd() },
      ).trim();
      expect(hits, `${name} is listed in the support bundle but nothing reads it`).not.toBe("");
    },
  );

  it("names TRUSTED_PROXY, not TRUST_PROXY", () => {
    // The specific regression, stated on its own so it reads as one.
    expect(names).toContain("TRUSTED_PROXY");
    expect(names).not.toContain("TRUST_PROXY");
  });
});
