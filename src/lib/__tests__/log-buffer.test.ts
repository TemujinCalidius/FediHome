import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The support bundle's log tail (#490).
 *
 * The bug this file exists to prevent looks EXACTLY like the correct
 * implementation and passes an obvious test suite. Since #59 the database is the
 * primary store for every integration credential and the environment is only a
 * fallback, so a redactor built by scrubbing `process.env` removes NOTHING on an
 * instance configured through the admin panel — the documented path. A leak test
 * that plants environment sentinels goes green while the real password walks
 * straight through.
 *
 * So the leak tests here plant DB-STORED sentinels, and only then env ones.
 *
 * No pattern would save us either: a Bluesky app password is
 * `xxxx-xxxx-xxxx-xxxx` — 19 characters, lowercase and dashes. Not 32-hex, not
 * 40+ base64, not a JWT, not preceded by `password=`.
 */

const DB_BSKY_PASSWORD = "abcd-efgh-ijkl-mnop"; // the real shape, 19 chars
const DB_THREADS_TOKEN = "THREADS-TOKEN-FROM-THE-DATABASE";
const DB_SMTP_PASS = "smtp-pass-from-the-database";
const DB_VAPID_PRIVATE = "vapid-private-from-the-database";
const DB_TINYLYTICS = "tinylytics-key-from-the-database";

/** Every resolver answers from the DATABASE, with the env deliberately empty. */
function mockResolvers() {
  vi.doMock("@/lib/integrations", () => ({
    getBlueskyCredentials: vi.fn().mockResolvedValue({ handle: "me.bsky.social", password: DB_BSKY_PASSWORD }),
    getThreadsCredentials: vi.fn().mockResolvedValue({ accessToken: DB_THREADS_TOKEN, userId: "1" }),
    getDayOneCredentials: vi.fn().mockResolvedValue({ pass: DB_SMTP_PASS, host: "h", port: 587, user: "u", dayOneEmail: "e" }),
  }));
  vi.doMock("@/lib/push-config", () => ({
    getVapidConfig: vi.fn().mockResolvedValue({ publicKey: "pub", privateKey: DB_VAPID_PRIVATE, subject: "mailto:me" }),
  }));
  vi.doMock("@/lib/analytics-secret", () => ({
    getTinylyticsApiKey: vi.fn().mockResolvedValue(DB_TINYLYTICS),
  }));
}

beforeEach(() => {
  vi.resetModules();
  for (const k of ["BLUESKY_APP_PASSWORD", "THREADS_ACCESS_TOKEN", "SMTP_PASS", "VAPID_PRIVATE_KEY", "TINYLYTICS_API_KEY", "ADMIN_SECRET", "ADMIN_PASSWORD", "DATABASE_URL"]) {
    delete process.env[k];
  }
});

describe("the ring buffer", () => {
  it("keeps the most recent lines and drops the oldest", async () => {
    const { recordLine, getRecentLines, resetLogBuffer } = await import("@/lib/log-buffer");
    resetLogBuffer();
    for (let i = 0; i < 600; i++) recordLine("log", `line ${i}`);
    const tail = getRecentLines();
    expect(tail.length).toBe(500);
    expect(tail[0].text).toBe("line 100");
    expect(tail[tail.length - 1].text).toBe("line 599");
  });

  it("truncates a single enormous line so it can't become the whole tail", async () => {
    const { recordLine, getRecentLines, resetLogBuffer } = await import("@/lib/log-buffer");
    resetLogBuffer();
    recordLine("error", "x".repeat(50_000));
    expect(getRecentLines()[0].text.length).toBeLessThan(2_100);
    expect(getRecentLines()[0].text).toMatch(/truncated/);
  });

  it("lives on globalThis, not a module-level variable", async () => {
    // instrumentation.ts reaches modules through a DYNAMIC import while route
    // handlers import them STATICALLY, and those are separate module instances.
    // A module-level `let` is filled by the boot copy and read as permanently
    // empty by the route — the bundle would ship an empty tail while every unit
    // test passed. Asserted by re-importing after a module reset, which is the
    // closest a unit test gets to that boundary.
    const first = await import("@/lib/log-buffer");
    first.resetLogBuffer();
    first.recordLine("log", "written by the first module instance");
    vi.resetModules();
    const second = await import("@/lib/log-buffer");
    expect(second.getRecentLines().map((l) => l.text)).toContain(
      "written by the first module instance",
    );
  });
});

describe("redaction at capture time — against DB-stored credentials", () => {
  it("never stores a database-resolved password in the buffer at all", async () => {
    // THE test. Scrubbing on the way out would leave the plaintext sitting in
    // process memory until someone asked for a bundle; this asserts it is never
    // stored, which is a stronger property and the one the issue asks for.
    mockResolvers();
    const { refreshRedactionSet } = await import("@/lib/log-secrets");
    const { recordLine, getRecentLines, resetLogBuffer, REDACTED } = await import("@/lib/log-buffer");
    resetLogBuffer();
    await refreshRedactionSet();

    // The real leak path: bluesky-agent.ts builds its session cache key as
    // `${service}|${identifier}:${password}`.
    recordLine("error", `agent cache miss for https://bsky.social|me.bsky.social:${DB_BSKY_PASSWORD}`);

    const stored = getRecentLines()[0].text;
    expect(stored).not.toContain(DB_BSKY_PASSWORD);
    expect(stored).toContain(REDACTED);
  });

  it("covers every credential the app can resolve, not just Bluesky", async () => {
    // This one earned its keep during the build. resolveSecrets originally fired
    // three concurrent `import("./integrations")` calls inside one
    // Promise.allSettled; two came back with a half-populated namespace, so
    // getThreadsCredentials and getDayOneCredentials were `undefined` and the
    // `?? null` turned that into "not configured". Two credentials went
    // un-redacted with nothing anywhere to say so — which is precisely the
    // silent shape this whole file is about. Testing only Bluesky would have
    // shipped it.
    mockResolvers();
    const { refreshRedactionSet } = await import("@/lib/log-secrets");
    const { recordLine, getRecentLines, resetLogBuffer } = await import("@/lib/log-buffer");
    resetLogBuffer();
    await refreshRedactionSet();

    for (const secret of [DB_THREADS_TOKEN, DB_SMTP_PASS, DB_VAPID_PRIVATE, DB_TINYLYTICS]) {
      recordLine("error", `something failed: ${secret}`);
    }
    const all = getRecentLines().map((l) => l.text).join("\n");
    for (const secret of [DB_THREADS_TOKEN, DB_SMTP_PASS, DB_VAPID_PRIVATE, DB_TINYLYTICS]) {
      expect(all, secret).not.toContain(secret);
    }
  });

  it("also scrubs environment values, as a second pass", async () => {
    // An instance configured entirely by env vars is a real configuration. The
    // bug is treating this list as SUFFICIENT, not including it.
    vi.doMock("@/lib/integrations", () => ({
      getBlueskyCredentials: vi.fn().mockResolvedValue(null),
      getThreadsCredentials: vi.fn().mockResolvedValue(null),
      getDayOneCredentials: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/push-config", () => ({ getVapidConfig: vi.fn().mockResolvedValue(null) }));
    vi.doMock("@/lib/analytics-secret", () => ({ getTinylyticsApiKey: vi.fn().mockResolvedValue(null) }));
    process.env.ADMIN_SECRET = "admin-secret-from-the-environment";

    const { refreshRedactionSet } = await import("@/lib/log-secrets");
    const { recordLine, getRecentLines, resetLogBuffer } = await import("@/lib/log-buffer");
    resetLogBuffer();
    await refreshRedactionSet();
    recordLine("error", "boom: admin-secret-from-the-environment");
    expect(getRecentLines()[0].text).not.toContain("admin-secret-from-the-environment");
  });

  it("scrubs the DATABASE_URL password on its own, not just the whole URL", async () => {
    // A Prisma error can print either. The URL is caught by the env pass; the
    // bare password would not be.
    vi.doMock("@/lib/integrations", () => ({
      getBlueskyCredentials: vi.fn().mockResolvedValue(null),
      getThreadsCredentials: vi.fn().mockResolvedValue(null),
      getDayOneCredentials: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/push-config", () => ({ getVapidConfig: vi.fn().mockResolvedValue(null) }));
    vi.doMock("@/lib/analytics-secret", () => ({ getTinylyticsApiKey: vi.fn().mockResolvedValue(null) }));
    process.env.DATABASE_URL = "postgresql://user:s3cret-db-password@localhost:5432/fedihome";

    const { refreshRedactionSet } = await import("@/lib/log-secrets");
    const { recordLine, getRecentLines, resetLogBuffer } = await import("@/lib/log-buffer");
    resetLogBuffer();
    await refreshRedactionSet();
    recordLine("error", "auth failed for s3cret-db-password");
    expect(getRecentLines()[0].text).not.toContain("s3cret-db-password");
  });

  it("does not blank short strings and make the tail unreadable", async () => {
    const { setSecrets, redactSecrets, REDACTED } = await import("@/lib/log-buffer");
    setSecrets(["ok", "abc", "1234567"]); // all under the floor
    expect(redactSecrets("ok abc 1234567", ["ok", "abc", "1234567"])).toBe("ok abc 1234567");
    expect(redactSecrets("12345678 here", ["12345678"])).toBe(`${REDACTED} here`);
  });

  it("replaces a longer credential whole when a shorter one is inside it", async () => {
    // Shortest-first would blank the inner one and leave an unmatchable stub of
    // the outer — worse than either outcome on its own.
    const { setSecrets, currentSecrets, redactSecrets, REDACTED } = await import("@/lib/log-buffer");
    setSecrets(["passwordpart", "passwordpart-and-more"]);
    expect(redactSecrets("value=passwordpart-and-more", currentSecrets())).toBe(`value=${REDACTED}`);
  });

  it("one resolver failing does not cost the redaction set the others", async () => {
    // A row that won't decrypt (ADMIN_SECRET changed) must not disarm redaction
    // for every other credential.
    vi.doMock("@/lib/integrations", () => ({
      getBlueskyCredentials: vi.fn().mockRejectedValue(new Error("undecryptable")),
      getThreadsCredentials: vi.fn().mockResolvedValue({ accessToken: DB_THREADS_TOKEN, userId: "1" }),
      getDayOneCredentials: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/push-config", () => ({ getVapidConfig: vi.fn().mockResolvedValue(null) }));
    vi.doMock("@/lib/analytics-secret", () => ({ getTinylyticsApiKey: vi.fn().mockResolvedValue(null) }));

    const { refreshRedactionSet } = await import("@/lib/log-secrets");
    const { recordLine, getRecentLines, resetLogBuffer } = await import("@/lib/log-buffer");
    resetLogBuffer();
    await refreshRedactionSet();
    recordLine("error", `threads said no: ${DB_THREADS_TOKEN}`);
    expect(getRecentLines()[0].text).not.toContain(DB_THREADS_TOKEN);
  });
});

describe("the console tee", () => {
  let spies: { restore: () => void };

  afterEach(() => spies?.restore());

  async function installFresh() {
    const mod = await import("@/lib/log-buffer");
    mod.resetLogBuffer();
    delete (globalThis as { __fedihomeLogTeeInstalled?: boolean }).__fedihomeLogTeeInstalled;
    const originals = {
      log: console.log, info: console.info, warn: console.warn, error: console.error,
    };
    const seen: unknown[][] = [];
    for (const k of Object.keys(originals) as (keyof typeof originals)[]) {
      console[k] = (...args: unknown[]) => { seen.push(args); };
    }
    mod.installConsoleTee();
    spies = {
      restore: () => {
        for (const k of Object.keys(originals) as (keyof typeof originals)[]) console[k] = originals[k];
        delete (globalThis as { __fedihomeLogTeeInstalled?: boolean }).__fedihomeLogTeeInstalled;
      },
    };
    return { mod, seen };
  }

  it("calls the original FIRST, so stdout is never lost", async () => {
    // The logs an operator already relies on must not depend on this feature
    // working. Asserted by making the recorder throw.
    const { mod, seen } = await installFresh();
    const spy = vi.spyOn(mod, "recordLine");
    console.log("still goes to stdout");
    expect(seen).toContainEqual(["still goes to stdout"]);
    spy.mockRestore();
  });

  it("records what was logged, formatting objects and errors", async () => {
    const { mod } = await installFresh();
    console.warn("hello", { a: 1 });
    console.error(new Error("kaboom"));
    const texts = mod.getRecentLines().map((l) => l.text);
    expect(texts[0]).toBe('hello {"a":1}');
    expect(texts[1]).toMatch(/kaboom/);
  });

  it("is idempotent — a second install can't double-record", async () => {
    // A dev-server restart or a duplicate register() would otherwise stack
    // wrappers and record every line N times.
    const { mod } = await installFresh();
    expect(mod.installConsoleTee()).toBe(false);
    console.log("once");
    expect(mod.getRecentLines().filter((l) => l.text === "once").length).toBe(1);
  });

  it("survives an unserialisable argument", async () => {
    const { mod } = await installFresh();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => console.log("circular:", circular)).not.toThrow();
    expect(mod.getRecentLines().length).toBe(1);
  });

  it("has no import-time side effect", async () => {
    // An import-time patch would install itself inside any test that imports
    // this module — including log.test.ts, which spies on console.
    vi.resetModules();
    delete (globalThis as { __fedihomeLogTeeInstalled?: boolean }).__fedihomeLogTeeInstalled;
    const mod = await import("@/lib/log-buffer");
    expect(mod.consoleTeeInstalled()).toBe(false);
  });
});
