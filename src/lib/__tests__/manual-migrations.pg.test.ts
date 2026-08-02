import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import pg from "pg";

/**
 * The manual migrations, executed against a real Postgres (#384, #410).
 *
 * Everything else in this suite mocks `@/lib/db`, so the SQL that runs on every
 * install had never been run by a test. That is exactly how #384 shipped: the
 * offending file's own header asserted idempotency, and nothing checked.
 *
 * Three acts, mirroring the three states a real database can be in:
 *
 *   1. **Fresh** — nothing exists. The pre-`db push` pass can only report that
 *      it isn't applicable yet; the pass AFTER schema creation does the work.
 *      This act is #410: before it was fixed those files applied only on the
 *      *next* boot, which nobody is told to perform.
 *   2. **Upgrade** — a pre-migration schema, every table present. One pass
 *      applies everything.
 *   3. **Live** — the app is running, and the #384 fixtures must survive.
 *
 * Every act asserts the output carries **no failures**. That matters more than
 * it sounds: `Applied 8 migration(s), 7 could not be applied` matches
 * `/Applied \d+ migration\(s\)/` perfectly happily, which is how this file
 * stayed green for days while seven files failed on every single run.
 *
 * The schema is built with raw SQL rather than `prisma db push`, deliberately:
 * this tests the migrations, not Prisma's schema sync, and starting from a
 * pre-migration shape is what lets acts 1 and 2 exist at all.
 *
 * Skipped unless FEDIHOME_TEST_DATABASE_URL points at a scratch database.
 */

const URL = process.env.FEDIHOME_TEST_DATABASE_URL;

const at = (s: string) => new Date(s);
const PRE_MARKERS = at("2026-05-01T10:00:00.000Z");
const LEGIT_BACKFILL = at("2026-06-01T10:00:00.000Z");
const WITNESS = at("2026-07-10T10:00:00.000Z");
const WITNESS_MARKER = new Date(WITNESS.getTime() + 42_000);
const CLOBBERED = at("2026-07-20T10:00:00.000Z");

/** Every table the migrations ALTER, in the shape it had before they ran. */
const TABLES = [
  `CREATE TABLE "Post" (
     "id" TEXT PRIMARY KEY, "slug" TEXT NOT NULL,
     "published" BOOLEAN NOT NULL DEFAULT true,
     "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "scheduledFor" TIMESTAMP(3))`,
  // apId NOT NULL on purpose: 2026-07-29-fedipost-bluesky-source drops that
  // constraint, so the column has to start out carrying it.
  //
  // actorUri/isOutgoing/boostedBy are ordinary Prisma columns that predate every
  // migration here, and 2026-08-02-fedipost-via-lookup's backfill reads all
  // three. They were absent because nothing had needed them yet — and a fixture
  // that is missing a column the SQL reads doesn't fail loudly: the runner
  // classifies the file as "not applicable yet" and moves on.
  `CREATE TABLE "FediPost" (
     "id" TEXT PRIMARY KEY, "apId" TEXT NOT NULL,
     "actorUri" TEXT NOT NULL DEFAULT '',
     "isOutgoing" BOOLEAN NOT NULL DEFAULT false,
     "boostedBy" TEXT)`,
  `CREATE TABLE "FediInteraction" ("id" TEXT PRIMARY KEY)`,
  `CREATE TABLE "FediFollowing" ("id" TEXT PRIMARY KEY, "actorUri" TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE "AuthToken" ("id" TEXT PRIMARY KEY)`,
  // TWO different tables, and the near-identical names are why this was missed:
  // "SiteSettings" (plural) is the singleton profile row; "SiteSetting"
  // (singular) is the key/value store that gates one-shot backfills. The
  // via-lookup migration reads and writes the SINGULAR one.
  `CREATE TABLE "SiteSettings" ("id" TEXT PRIMARY KEY)`,
  `CREATE TABLE "SiteSetting" (
     "key" TEXT PRIMARY KEY, "value" TEXT NOT NULL,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  // 2026-07-30-maintenanceitem-resolved adds resolvedAt/occurrences to this.
  `CREATE TABLE "MaintenanceItem" (
     "id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "packageName" TEXT NOT NULL,
     "latest" TEXT, "dismissed" BOOLEAN NOT NULL DEFAULT false,
     "applied" BOOLEAN NOT NULL DEFAULT false,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
];

/** Everything the migrations themselves create, plus the ledger. */
const MIGRATION_OWNED = [
  "PushSubscription", "BlueskyInteraction", "AuthorizationCode", "AppTokenUsage",
  "BlockedActor", "FailedDelivery", "FailedCrosspost", "BlockedDomain", "ManualMigration",
];

describe.skipIf(!URL)("manual migrations against real Postgres", () => {
  let client: pg.Client;

  const runMigrations = () =>
    execFileSync("node", ["scripts/apply-migrations.mjs"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: URL },
    });

  /** Back to genuinely nothing — the state a brand-new install starts from. */
  const wipe = async () => {
    const names = [...TABLES.map((t) => t.match(/"([^"]+)"/)![1]), ...MIGRATION_OWNED];
    await client.query(names.map((n) => `DROP TABLE IF EXISTS "${n}" CASCADE;`).join("\n"));
  };

  /** Stands in for `prisma db push`, which won't run under an agent. */
  const createSchema = () => client.query(TABLES.join(";\n") + ";");

  const insert = (id: string, publishedAt: Date, federatedAt: Date | null, withMarker = true) =>
    client.query(
      withMarker
        ? `INSERT INTO "Post" ("id","slug","published","publishedAt","updatedAt","scheduledFor","federatedAt")
           VALUES ($1,$1,true,$2,$2,$2,$3)`
        : `INSERT INTO "Post" ("id","slug","published","publishedAt","updatedAt","scheduledFor")
           VALUES ($1,$1,true,$2,$2,$2)`,
      withMarker ? [id, publishedAt, federatedAt] : [id, publishedAt],
    );

  const marker = async (id: string): Promise<Date | null> => {
    const { rows } = await client.query(`SELECT "federatedAt" FROM "Post" WHERE "id" = $1`, [id]);
    return rows[0].federatedAt;
  };

  const ledgerCount = async (): Promise<number> => {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM "ManualMigration"`);
    return rows[0].n;
  };

  const fileCount = (): number =>
    Number(
      execFileSync("sh", ["-c", "ls prisma/manual-migrations/*.sql | wc -l"], {
        encoding: "utf8",
      }).trim(),
    );

  beforeAll(async () => {
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end().catch(() => {});
  });

  describe("act 1 — a fresh install (#410)", () => {
    let firstPass = "";
    let secondPass = "";

    beforeAll(async () => {
      await wipe();
      firstPass = runMigrations(); //  the pre-`db push` pass
      await createSchema(); //         stands in for `db push`
      secondPass = runMigrations(); // the pass that now runs after it
    });

    it("says the schema isn't ready rather than reporting failures", () => {
      // Twenty ⚠️ lines on a brand-new install read as a broken install. They
      // aren't failures — there is simply nothing to alter yet.
      expect(firstPass).toMatch(/not applicable yet/);
      expect(firstPass).not.toMatch(/could not be applied/);
      expect(firstPass).not.toMatch(/⚠️/);
    });

    it("applies everything in the SAME boot, once the schema exists", async () => {
      // The whole of #410: these used to land only on the next restart.
      expect(secondPass).not.toMatch(/could not be applied/);
      expect(secondPass).not.toMatch(/not applicable yet/);
      expect(await ledgerCount()).toBe(fileCount());
    });

    it("is a fixed point straight away — no third boot needed", () => {
      const third = runMigrations();
      expect(third).toMatch(/Applied 0 migration\(s\)\./);
      expect(third).not.toMatch(/could not be applied/);
    });
  });

  describe("act 2 — an upgrade, every table already present", () => {
    let out = "";

    beforeAll(async () => {
      await wipe();
      await createSchema();
      await insert("pre-markers", PRE_MARKERS, null, false);
      out = runMigrations();
    });

    it("applies every file in one pass, with no failures", () => {
      expect(out).not.toMatch(/could not be applied/);
      expect(out).not.toMatch(/not applicable yet/);
      expect(out).toMatch(new RegExp(`Applied ${fileCount()} migration\\(s\\)\\.`));
    });

    it("adds the resolvable-alert columns with usable defaults (#412)", async () => {
      // Pure ADD COLUMN IF NOT EXISTS, no backfill: every pre-existing row is by
      // definition still outstanding, so NULL and 1 are already correct for it —
      // which is exactly what the column defaults supply at ALTER time.
      await client.query(
        `INSERT INTO "MaintenanceItem" ("id","kind","packageName","latest")
         VALUES ('m1','update','next','16.1.0')`,
      );
      const { rows } = await client.query(
        `SELECT "resolvedAt","occurrences" FROM "MaintenanceItem" WHERE "id" = 'm1'`,
      );
      expect(rows[0]).toEqual({ resolvedAt: null, occurrences: 1 });
    });

    it("runs the creation-guarded backfill for real", async () => {
      // The pattern the README mandates. On a fresh install under the OLD
      // ordering this guard was pre-satisfied by `db push` and the body never
      // ran — silently, since the RAISE NOTICE never fired either.
      expect(await marker("pre-markers")).toEqual(PRE_MARKERS);
      expect(out).toMatch(/federatedAt created and backfilled/);
    });
  });

  describe("act 3 — the app is live (#384)", () => {
    beforeAll(async () => {
      await client.query(`DELETE FROM "Post"`);
      // Legitimate pre-#195 backfill: same signature as damage, but it predates
      // any marker this install ever wrote from code.
      await insert("legit", LEGIT_BACKFILL, LEGIT_BACKFILL);
      // A genuine delivery — marker 42s after publication. The witness proving
      // the install was writing markers from code by then.
      await insert("witness", WITNESS, WITNESS_MARKER);
      // Clobbered by the old ungated backfill while still in flight.
      await insert("clobbered", CLOBBERED, CLOBBERED);
      // Mid-delivery RIGHT NOW: claimed, not yet federated.
      await insert("inflight", new Date(), null);

      await client.query(`DELETE FROM "ManualMigration"`); // force a re-apply
      runMigrations();
    });

    it("leaves a post that is mid-delivery right now completely alone", async () => {
      // THE #384 regression test. The pre-fix backfill sets this, which both
      // marks an undelivered post as delivered and removes it from the sweep.
      expect(await marker("inflight")).toBeNull();
    });

    it("clears the marker the old backfill wrote over a stranded post", async () => {
      expect(await marker("clobbered")).toBeNull();
    });

    it("does not touch the legitimate pre-markers backfill", async () => {
      // Held out by the EXISTS witness. Drop that clause and this fails — and a
      // false positive here costs the owner a duplicate Bluesky post.
      expect(await marker("legit")).toEqual(LEGIT_BACKFILL);
    });

    it("does not touch a genuine delivery", async () => {
      expect(await marker("witness")).toEqual(WITNESS_MARKER);
    });

    it("is a fixed point — a second run applies nothing and changes nothing", async () => {
      const before = await client.query(`SELECT "id","federatedAt" FROM "Post" ORDER BY "id"`);
      const out = runMigrations();
      expect(out).toMatch(/Applied 0 migration\(s\)\./);
      expect(out).not.toMatch(/could not be applied/);
      const after = await client.query(`SELECT "id","federatedAt" FROM "Post" ORDER BY "id"`);
      expect(after.rows).toEqual(before.rows);
    });

    it("re-applies a file whose content changed, without touching the others", async () => {
      await client.query(`UPDATE "ManualMigration" SET "hash" = 'stale' WHERE "name" LIKE '%repair-federatedat%'`);
      const out = runMigrations();
      expect(out).toMatch(/Applied 1 migration\(s\)\./);
    });
  });

  describe("the ledger table matches its Prisma model", () => {
    // If the DDL in apply-migrations.mjs drifted from the ManualMigration model,
    // the next `db push` on a real install would want to change the table,
    // demand --accept-data-loss (which the Docker CMD does not pass), and
    // crash-loop every container. Checked structurally rather than by running
    // `db push`, so it holds in CI too.
    it("has the columns, types and primary key the model declares", async () => {
      const { rows } = await client.query(
        `SELECT column_name, data_type, is_nullable, datetime_precision, column_default
           FROM information_schema.columns
          WHERE table_name = 'ManualMigration' ORDER BY column_name`,
      );
      expect(rows.map((r) => r.column_name)).toEqual(["appliedAt", "hash", "name"]);
      const by = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(by.name).toMatchObject({ data_type: "text", is_nullable: "NO" });
      expect(by.hash).toMatchObject({ data_type: "text", is_nullable: "NO" });
      expect(by.appliedAt).toMatchObject({ data_type: "timestamp without time zone", is_nullable: "NO" });
      expect(by.appliedAt.datetime_precision).toBe(3);
      expect(by.appliedAt.column_default).toBeTruthy();

      const pk = await client.query(
        `SELECT a.attname FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = '"ManualMigration"'::regclass AND i.indisprimary`,
      );
      expect(pk.rows.map((r) => r.attname)).toEqual(["name"]);
    });
  });
});
