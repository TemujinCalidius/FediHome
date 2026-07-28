import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import pg from "pg";

/**
 * The manual migrations, executed against a real Postgres (#384).
 *
 * Everything else in this suite mocks `@/lib/db`, so the SQL that actually runs
 * on every install had never been executed by a test. That is exactly how #384
 * shipped: the offending file's own header asserted idempotency, and nothing
 * checked.
 *
 * Two acts, mirroring the two states a real database can be in:
 *
 *   1. `federatedAt` doesn't exist yet — the column is created and the one-shot
 *      backfill runs. This is the path the guard in
 *      2026-07-03-post-delivery-markers.sql fences.
 *   2. The column exists and the app is live. Nothing may be touched except rows
 *      the old ungated backfill damaged.
 *
 * The fixture that matters most is `inflight`: a post that is mid-delivery right
 * now. Against the pre-fix file it gets marked delivered — the whole of #384 in
 * one row.
 *
 * The schema is built with raw SQL rather than `prisma db push`, deliberately:
 * this tests the migrations, not Prisma's schema sync, and starting from a
 * pre-migration shape is what lets act 1 exist at all.
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

/** The `Post` shape as it stood BEFORE 2026-07-03 — no markers. */
const PRE_MIGRATION_SCHEMA = `
DROP TABLE IF EXISTS "Post";
DROP TABLE IF EXISTS "ManualMigration";
CREATE TABLE "Post" (
  "id"           TEXT PRIMARY KEY,
  "slug"         TEXT NOT NULL,
  "published"    BOOLEAN NOT NULL DEFAULT true,
  "publishedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "scheduledFor" TIMESTAMP(3)
);`;

describe.skipIf(!URL)("manual migrations against real Postgres", () => {
  let client: pg.Client;

  const runMigrations = () =>
    execFileSync("node", ["scripts/apply-migrations.mjs"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: URL },
    });

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

  beforeAll(async () => {
    client = new pg.Client({ connectionString: URL });
    await client.connect();
    await client.query(PRE_MIGRATION_SCHEMA);
  });

  afterAll(async () => {
    await client?.end().catch(() => {});
  });

  describe("act 1 — the column does not exist yet", () => {
    it("creates federatedAt and backfills pre-markers scheduled posts, exactly once", async () => {
      await insert("pre-markers", PRE_MARKERS, null, false);

      const out = runMigrations();
      expect(out).toMatch(/Applied \d+ migration\(s\)/);

      // The one-shot backfill inside the creation guard: this post really had
      // already delivered before markers existed, so it must not be re-sent.
      expect(await marker("pre-markers")).toEqual(PRE_MARKERS);
    });
  });

  describe("act 2 — the column exists and the app is live", () => {
    beforeAll(async () => {
      await client.query(`DELETE FROM "Post"`);
      // Legitimate pre-#195 backfill: carries the same signature as damage, but
      // predates any marker this install ever wrote from code.
      await insert("legit", LEGIT_BACKFILL, LEGIT_BACKFILL);
      // A genuine delivery — the marker lands 42s after publication. This is the
      // witness proving the install was writing markers from code by then.
      await insert("witness", WITNESS, WITNESS_MARKER);
      // Clobbered by the old ungated backfill while it was still in flight.
      await insert("clobbered", CLOBBERED, CLOBBERED);
      // Mid-delivery RIGHT NOW: claimed, not yet federated.
      await insert("inflight", new Date(), null);

      // Force a re-apply: the ledger recorded act 1's run.
      await client.query(`DELETE FROM "ManualMigration"`);
      runMigrations();
    });

    it("leaves a post that is mid-delivery right now completely alone", async () => {
      // THE regression test. The pre-fix backfill sets this, which both marks an
      // undelivered post as delivered and removes it from the retry sweep.
      expect(await marker("inflight")).toBeNull();
    });

    it("clears the marker the old backfill wrote over a stranded post", async () => {
      expect(await marker("clobbered")).toBeNull();
    });

    it("does not touch the legitimate pre-markers backfill", async () => {
      // Held out by the EXISTS witness: nothing published before 2026-06-01
      // carries a prompt marker, so this row can't be proved to be damage. Drop
      // that clause and this fails — and a false positive here costs the owner a
      // duplicate Bluesky post.
      expect(await marker("legit")).toEqual(LEGIT_BACKFILL);
    });

    it("does not touch a genuine delivery", async () => {
      expect(await marker("witness")).toEqual(WITNESS_MARKER);
    });

    it("is a fixed point — a second run applies nothing and changes nothing", async () => {
      const before = await client.query(`SELECT "id","federatedAt" FROM "Post" ORDER BY "id"`);
      const out = runMigrations();
      expect(out).toMatch(/Applied 0 migration\(s\)/);
      const after = await client.query(`SELECT "id","federatedAt" FROM "Post" ORDER BY "id"`);
      expect(after.rows).toEqual(before.rows);
    });

    it("re-applies a file whose content changed, without touching the others", async () => {
      await client.query(`UPDATE "ManualMigration" SET "hash" = 'stale' WHERE "name" LIKE '%repair-federatedat%'`);
      const out = runMigrations();
      expect(out).toMatch(/Applied 1 migration\(s\)/);
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
