import { describe, it, expect } from "vitest";
// Dependency-free .mjs so the runner can import it inside a container; tested
// here from the same source, like check-changelog-sync.mjs.
import { planMigrations } from "../../../scripts/apply-migrations-plan.mjs";

/**
 * Which manual migrations get applied (#384).
 *
 * The ledger turns "re-executed on every container start forever" into
 * "executed once", which is what bounds the damage of any future
 * non-idempotent file. The rule that carries the most weight here is the
 * hash comparison — see the last block.
 */

const f = (name: string, hash: string) => ({ name, hash });

describe("planMigrations", () => {
  it("runs everything when the ledger is empty", () => {
    const files = [f("2026-01-01-a.sql", "h1"), f("2026-02-01-b.sql", "h2")];
    const { run, skip } = planMigrations(files, []);
    expect(run).toEqual(files);
    expect(skip).toEqual([]);
  });

  it("skips a file recorded at the same hash", () => {
    const files = [f("2026-01-01-a.sql", "h1")];
    const { run, skip } = planMigrations(files, [{ name: "2026-01-01-a.sql", hash: "h1" }]);
    expect(run).toEqual([]);
    expect(skip).toEqual(files);
  });

  it("RE-RUNS a file whose content changed", () => {
    // The load-bearing rule. The hash is compared, not merely keyed on — so an
    // edited file still applies. Without this, the fix to
    // 2026-07-03-post-delivery-markers.sql would never reach any install that
    // had already recorded that filename, which is every install there is.
    const files = [f("2026-07-03-post-delivery-markers.sql", "fixed")];
    const { run, skip } = planMigrations(files, [
      { name: "2026-07-03-post-delivery-markers.sql", hash: "broken" },
    ]);
    expect(run).toEqual(files);
    expect(skip).toEqual([]);
  });

  it("applies in name order, whatever order the files arrive in", () => {
    // Execution order is a correctness property: 2026-07-03 touches a column
    // 2026-07-02 creates. Date-prefixed names make lexicographic order correct.
    const { run } = planMigrations(
      [f("2026-07-03-c.sql", "h"), f("2026-07-01-a.sql", "h"), f("2026-07-02-b.sql", "h")],
      [],
    );
    expect(run.map((m) => m.name)).toEqual(["2026-07-01-a.sql", "2026-07-02-b.sql", "2026-07-03-c.sql"]);
  });

  it("ignores ledger rows for files that no longer exist", () => {
    // A removed file is history; the record of having run it is still true, so
    // it is never deleted — and it must not affect what runs now.
    const files = [f("2026-02-01-b.sql", "h2")];
    const { run, skip } = planMigrations(files, [
      { name: "2026-01-01-deleted.sql", hash: "gone" },
      { name: "2026-02-01-b.sql", hash: "h2" },
    ]);
    expect(run).toEqual([]);
    expect(skip).toEqual(files);
  });

  it("handles a mixed ledger", () => {
    const files = [f("a.sql", "h1"), f("b.sql", "NEW"), f("c.sql", "h3")];
    const { run, skip } = planMigrations(files, [
      { name: "a.sql", hash: "h1" },
      { name: "b.sql", hash: "OLD" },
    ]);
    expect(run.map((m) => m.name)).toEqual(["b.sql", "c.sql"]);
    expect(skip.map((m) => m.name)).toEqual(["a.sql"]);
  });

  it("tolerates missing arguments rather than throwing at boot", () => {
    // The runner calls this at boot; a shape surprise must not take the boot down.
    const loose = planMigrations as (a?: unknown, b?: unknown) => { run: unknown[]; skip: unknown[] };
    expect(loose(undefined, undefined)).toEqual({ run: [], skip: [] });
  });
});
