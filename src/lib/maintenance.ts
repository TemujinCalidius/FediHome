import { prisma } from "./db";

/**
 * Raising and resolving the items behind the notification bell (#412).
 *
 * `MaintenanceItem` had eight writers and exactly one of them ever cleared
 * anything, so the bell filled up and stayed full:
 *
 *  - a dependency alert is minted per upstream version, so `next → .13`, `→ .14`
 *    and `→ .15` all sat there as three separate live items;
 *  - a package you had already upgraded kept nagging, because nothing noticed;
 *  - **resolved advisories never cleared** — `npm audit` returning zero produces
 *    zero iterations, so nothing reconciles. An instance that checked once while
 *    an advisory existed still reported it long after it was fixed. That is the
 *    one that actively misleads;
 *  - `{kind:"update", packageName:"fedihome"}`, written by the release-tag
 *    fallback, was matched by **neither** existing cleanup (both filtered
 *    `kind:"release-note"`) — and containers take that path by default, because
 *    `FEDIHOME_BUILD_SHA` is only set if you pass it to `docker compose build`.
 *    So a container accumulated one live row per tagged release, forever.
 *
 * The fix is mark-and-sweep: a checker that *enumerates* a condition knows the
 * complete current set for its kind, so anything it did not re-see this run no
 * longer holds and is resolved.
 *
 * **Resolved, not deleted.** A recurring fault should read as "this happened
 * again", not arrive looking brand new every time — you cannot spot a flapping
 * credential if each occurrence is indistinguishable from a first one.
 */

/**
 * Identities that a sweep must never touch, as `kind/packageName`.
 *
 * These come from **one-shot** checks — something either happened or it didn't —
 * rather than from an enumerator, and they share a `kind` with an enumerated
 * source. `npm audit` has no opinion about whether your credentials decrypt, so
 * a security sweep listing every vulnerable package would otherwise resolve both
 * of these on its first run.
 *
 * Exemption lives here rather than at each call site on purpose: the failure mode
 * to design out is a *new* sweep forgetting to exclude an alert it has never
 * heard of. A new one-shot alert sharing a swept kind belongs in this list.
 */
export const NEVER_SWEPT: ReadonlySet<string> = new Set([
  "security/stored-credentials", //  secret-health.ts — resolves itself when they decrypt again
  "security/federation-identity", // federation.ts — a past event, so it never resolves at all
]);

export interface RaiseInput {
  kind: string;
  packageName: string;
  latest: string;
  title: string;
  severity?: string | null;
  description?: string | null;
  url?: string | null;
  current?: string | null;
}

/**
 * Raise an item, or record a fresh occurrence of one that had been resolved.
 *
 * Three cases, and the middle one is the whole reason this isn't just an upsert:
 *
 *  - **no row** → create it.
 *  - **row exists and is UNRESOLVED** → leave it completely alone. This is what
 *    preserves a dismissal: the owner has already seen this exact item and waved
 *    it away, and re-raising would resurrect it on every check. (The `update: {}`
 *    idiom the previous writers all used, kept deliberately.)
 *  - **row exists and was RESOLVED** → the condition has come back. Clear
 *    `resolvedAt`, clear `dismissed`, bump `occurrences`, refresh the wording. A
 *    dismissal doesn't carry across a resolution, because this is a new event
 *    rather than the same one still outstanding.
 *
 * `refresh` covers the fields that legitimately drift while an item stays
 * outstanding — `current` moves when you upgrade some of a tree but not all of
 * it, and a description gets rewritten. It updates the wording in place and
 * still never touches `dismissed`: re-wording an alert the owner dismissed is
 * fine, putting it back in front of them is not.
 */
export async function raiseMaintenanceItem(
  input: RaiseInput,
  opts: { refresh?: boolean } = {},
): Promise<void> {
  const { kind, packageName, latest, ...rest } = input;
  const where = { kind_packageName_latest: { kind, packageName, latest } };

  const existing = await prisma.maintenanceItem.findUnique({ where });

  if (!existing) {
    await prisma.maintenanceItem.create({ data: { kind, packageName, latest, ...rest } });
    return;
  }

  if (!existing.resolvedAt) {
    // Still outstanding — don't disturb a dismissal.
    if (opts.refresh) await prisma.maintenanceItem.update({ where, data: rest });
    return;
  }

  await prisma.maintenanceItem.update({
    where,
    data: {
      ...rest,
      resolvedAt: null,
      dismissed: false,
      applied: false,
      occurrences: existing.occurrences + 1,
    },
  });
}

/**
 * The identity a sweep compares on.
 *
 * A space is an unambiguous delimiter here even though `latest` can contain one
 * (`">=1.0 <2.0"` is a legitimate advisory range): an npm package name cannot, so
 * the FIRST space is always the boundary.
 */
export function seenKey(packageName: string, latest: string): string {
  return `${packageName} ${latest}`;
}

/**
 * Mark and sweep: resolve every unresolved item of `kind` whose identity is not
 * in the set the checker just observed.
 *
 * Only safe for a checker that enumerates the *complete* current set for its
 * kind. Where a kind has more than one owner — `update` is written both by the
 * npm check and by the FediHome release-tag fallback — pass `exceptPackages` so
 * each owner sweeps only its own rows.
 *
 * Returns how many were resolved, for the run log.
 */
export async function sweepResolved(
  kind: string,
  seen: Set<string>,
  opts: { exceptPackages?: string[] } = {},
): Promise<number> {
  const except = new Set(opts.exceptPackages ?? []);

  const live = await prisma.maintenanceItem.findMany({
    where: { kind, resolvedAt: null },
    select: { id: true, packageName: true, latest: true },
  });

  const gone = live
    .filter(
      (m) =>
        !except.has(m.packageName) &&
        !NEVER_SWEPT.has(`${kind}/${m.packageName}`) &&
        !seen.has(seenKey(m.packageName, m.latest ?? "")),
    )
    .map((m) => m.id);

  if (gone.length === 0) return 0;

  await prisma.maintenanceItem.updateMany({
    where: { id: { in: gone } },
    data: { resolvedAt: new Date() },
  });
  return gone.length;
}

/**
 * Resolve one specific item, for the alerts a sweep can't reach — the one-shot
 * boot checks that either find a problem or don't, and so have no set to
 * enumerate.
 *
 * Never throws: these sit on boot and render paths, where a diagnostic must not
 * be the reason something fails.
 */
export async function resolveMaintenanceItem(
  kind: string,
  packageName: string,
  latest: string,
): Promise<void> {
  try {
    await prisma.maintenanceItem.updateMany({
      where: { kind, packageName, latest, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  } catch {
    /* a diagnostic must never break the path it runs on */
  }
}
