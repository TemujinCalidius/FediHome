/**
 * Which manual migrations need applying — pure logic, no I/O (#384).
 *
 * Split out from the runner so it can be unit-tested without a database, the
 * same way `check-changelog-sync.mjs` is. Dependency-free on purpose: the runner
 * imports it inside a container where only production deps exist.
 */

/**
 * Decide what to run.
 *
 * @param {{name: string, hash: string}[]} files   present on disk
 * @param {{name: string, hash: string}[]} applied rows from the ledger
 * @returns {{run: {name: string, hash: string}[], skip: {name: string, hash: string}[]}}
 *
 * Rules:
 *  - Sorted by name. Execution order is a correctness property (a file may
 *    depend on a column an earlier one creates), and the date-prefixed names
 *    make plain lexicographic order the right order.
 *  - Unrecorded → run.
 *  - Recorded with a DIFFERENT hash → run again. The hash is compared, not just
 *    keyed on, so an edited file still applies. Without this, a fix to a file an
 *    install had already recorded would never reach it — which is exactly the
 *    situation #384's fix is in.
 *  - Recorded with the same hash → skip.
 *  - Ledger rows for files that no longer exist are ignored, never deleted:
 *    a removed file is history, and the record of having run it is still true.
 */
export function planMigrations(files, applied) {
  const seen = new Map((applied ?? []).map((r) => [r.name, r.hash]));
  const sorted = [...(files ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const run = [];
  const skip = [];
  for (const f of sorted) {
    if (seen.get(f.name) === f.hash) skip.push(f);
    else run.push(f);
  }
  return { run, skip };
}
