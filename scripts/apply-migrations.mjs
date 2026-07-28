#!/usr/bin/env node
/**
 * Apply the hand-written SQL in prisma/manual-migrations/ before `prisma db push`.
 *
 * WHY THESE FILES EXIST: `db push` refuses to add a unique constraint without
 * --accept-data-loss — even a provably safe additive one on a brand-new column —
 * so any change needing one ships as a `CREATE ... IF NOT EXISTS` file here.
 * Pre-applying them means the `db push` that follows sees no diff and never
 * trips the data-loss guard. (#124)
 *
 * WHY A LEDGER (#384): the convention was "every file must be idempotent", which
 * was a comment in a shell script, and it failed exactly once — in the file whose
 * own header claimed idempotency. Recording what has run turns "re-executed on
 * every boot forever" into "executed once", which shrinks the blast radius of any
 * future mistake from unbounded to a single run. It is defence in depth, NOT a
 * licence: the fail-safe direction below is to run everything again, so every
 * file must still be idempotent. `src/lib/__tests__/manual-migrations.test.ts`
 * enforces that.
 *
 * WHY NODE, NOT SHELL: `prisma db execute` cannot return rows, so a shell
 * implementation could not read a ledger without spawning a process per file —
 * which is the cost this removes. It also cannot hash portably: busybox has
 * `sha256sum`, stock macOS does not, and update.sh runs on the host. `pg` and
 * `dotenv` are already direct dependencies and the Dockerfile ships both
 * `scripts/` and the whole `node_modules`.
 *
 * ALWAYS EXITS 0. The Docker CMD chains this with `&&`, so a non-zero exit would
 * stop `db push` AND the server. A migration that cannot be applied is reported
 * and skipped; the `db push` that follows either reconciles it or reports the
 * real cause with a better message than a raw SQL error.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { planMigrations } from "./apply-migrations-plan.mjs";

// Same order as prisma.config.ts — .env.local wins — or a bare-metal update.sh
// run would silently find no database and skip everything.
// quiet: dotenv's banner is noise in a boot log, and it reports "(0)" when the
// variables came from the container environment rather than a file.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const DIR = process.argv[2] || path.join("prisma", "manual-migrations");
const LEDGER = "ManualMigration";
// Arbitrary but fixed: serialises two instances booting against one database.
const ADVISORY_LOCK_KEY = 8_384_001;
const LOCK_WAIT_MS = 30_000;

/**
 * Bootstrap DDL for the ledger.
 *
 * ⚠️ `ManualMigration` MUST also be a model in prisma/schema.prisma. `db push`
 * diffs the whole database against the schema and drops tables it doesn't know
 * about — so an unmanaged ledger would make the very next `db push` demand
 * --accept-data-loss, which the Docker CMD does not pass, and every container
 * would exit 1 into a restart loop. This DDL matches what `db push` generates
 * for that model, so the push which follows sees no diff.
 */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS "${LEDGER}" (
  "name"      TEXT NOT NULL,
  "hash"      TEXT NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "${LEDGER}_pkey" PRIMARY KEY ("name")
);`;

const say = (m) => console.log(`  ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);

function readMigrations() {
  if (!existsSync(DIR)) return null;
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => {
      const sql = readFileSync(path.join(DIR, name), "utf8");
      return { name, hash: createHash("sha256").update(sql).digest("hex"), sql };
    });
}

/** Best-effort serialisation. Proceeding after the wait beats holding up a boot. */
async function acquireLock(client) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK_KEY]);
    if (rows[0].ok) return true;
    if (Date.now() >= deadline) {
      warn("another process is applying migrations and hasn't finished — continuing anyway.");
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const files = readMigrations();
  if (files === null) return say(`No manual migrations directory (${DIR}) — nothing to apply.`);
  if (files.length === 0) return say("No manual migrations to apply.");

  if (!process.env.DATABASE_URL) {
    warn("DATABASE_URL is not set — skipping manual migrations.");
    return;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  // Migrations can now talk to the operator; `prisma db execute` swallowed these.
  client.on("notice", (n) => n?.message && say(n.message));

  try {
    await client.connect();
  } catch (err) {
    warn(`Could not connect to the database: ${err.message}`);
    return;
  }

  let locked = false;
  try {
    locked = await acquireLock(client);

    // Fail-safe: if the ledger can't be created or read, run EVERYTHING, exactly
    // as before it existed. Never skip on an unreadable ledger — a skipped
    // `CREATE UNIQUE INDEX` is what makes `db push` trip the data-loss guard,
    // which is the crash-loop #355 was written to prevent.
    let applied = [];
    let ledgerOk = true;
    try {
      // Bootstrap quietly: "relation already exists, skipping" on every boot is
      // noise, and unlike a migration's own notices it tells the operator nothing.
      // Session-level, not SET LOCAL: we're not inside a transaction here.
      await client.query("SET client_min_messages TO WARNING");
      await client.query(LEDGER_DDL);
      await client.query("RESET client_min_messages");
      const { rows } = await client.query(`SELECT "name", "hash" FROM "${LEDGER}"`);
      applied = rows;
    } catch (err) {
      ledgerOk = false;
      warn(`Migration ledger unavailable (${err.message}) — applying every migration, as before.`);
    }

    const { run, skip } = planMigrations(files, ledgerOk ? applied : []);
    if (skip.length > 0) say(`${skip.length} migration(s) already applied.`);

    let ok = 0;
    let failed = 0;
    for (const m of run) {
      const file = files.find((f) => f.name === m.name);
      say(`Applying ${m.name}…`);
      try {
        // The file and its ledger row commit together, so a half-applied file is
        // never recorded as done.
        await client.query("BEGIN");
        await client.query(file.sql);
        if (ledgerOk) {
          await client.query(
            `INSERT INTO "${LEDGER}" ("name","hash") VALUES ($1,$2)
             ON CONFLICT ("name") DO UPDATE SET "hash" = EXCLUDED."hash", "appliedAt" = now()`,
            [m.name, m.hash],
          );
        }
        await client.query("COMMIT");
        ok++;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        failed++;
        warn(`Could not apply ${m.name}: ${err.message}`);
        warn("Continuing; the 'db push' that follows will reconcile or report the cause.");
      }
    }

    const tail = failed > 0 ? `, ${failed} could not be applied (see above)` : "";
    say(`Applied ${ok} migration(s)${tail}.`);
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }
}

main()
  .catch((err) => warn(`Manual migrations could not be applied: ${err.message}`))
  // Never non-zero: see the header.
  .finally(() => process.exit(0));
