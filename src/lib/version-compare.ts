/**
 * Version comparison for the update checker (#465).
 *
 * Lives here rather than inside scripts/check-updates.ts because that file calls
 * main() at the top level — importing it from a test runs a real update check.
 * The comparison is the part with the bug in it, so it is the part that needs to
 * be reachable from a test.
 */

/** Naive semver-ish comparison — enough for our own x.y.z tags and npm's. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

/**
 * Is moving from `current` to `latest` actually an UPGRADE?
 *
 * The package loop used to ask only whether the two differed, so whenever npm
 * reported a `latest` older than what was installed, FediHome raised a
 * maintenance alert telling the operator to move backwards — labelled "(major)",
 * because that was string inequality on the first segment. Indistinguishable
 * from a real alert, including in the notification bell.
 *
 * The self-check already guarded this correctly; this is the same question asked
 * once, in one place, for both callers.
 */
export function isUpgrade(current: string, latest: string): boolean {
  if (!latest || !current || latest === current) return false;
  return isNewer(latest, current);
}

/** Only true when it is an upgrade AND the major segment actually increased. */
export function isMajorUpgrade(current: string, latest: string): boolean {
  if (!isUpgrade(current, latest)) return false;
  return (parseInt(latest.split(".")[0], 10) || 0) > (parseInt(current.split(".")[0], 10) || 0);
}
