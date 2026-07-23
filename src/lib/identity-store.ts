import { prisma } from "./db";
import { applyIdentityOverrides, clearIdentityOverrides, getIdentity } from "./identity";

/**
 * The database half of federation identity (#326 Phase 1).
 *
 * Kept separate from `identity.ts` on purpose: that module is imported by
 * `site.config.ts`, which reaches client bundles, so importing `prisma` there
 * would pull the database client into the browser. This module is server-only
 * and *pushes* the loaded values into the accessor, which stays synchronous —
 * that's what lets ~60 call sites, several of them in sync helpers, keep working
 * without becoming async.
 *
 * **Loaded once at boot** (`src/instrumentation.ts`), not per request and not on
 * a TTL. Identity effectively never changes, a stale value here is far worse
 * than a stale setting elsewhere, and `getIdentity()` is synchronous so it
 * cannot refresh itself anyway. Anything that writes these rows must call
 * `refreshIdentity()`.
 *
 * **Read-only for now.** No UI writes `identity.*`, so every instance still
 * resolves from the environment. The write path, the admin UI, and the
 * change-domain migration are later phases — and the migration is the hard part:
 * ActivityPub has no rename, so moving domains means `alsoKnownAs` + a `Move`
 * activity served from the OLD instance while it is still reachable.
 */

const KEY_PREFIX = "identity.";
const FIELDS = ["siteUrl", "fediHandle", "fediDomain"] as const;
type IdentityField = (typeof FIELDS)[number];

export const IDENTITY_KEYS = FIELDS.map((f) => `${KEY_PREFIX}${f}`);

/** Reject junk so a bad row can't produce a malformed actor id. */
function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.length > 300 || /[\s\r\n]/.test(v)) return undefined;
  return v;
}

/**
 * Load the `identity.*` overrides from the database into the accessor.
 *
 * Never throws: a database that is down or mid-migration must not stop the
 * server booting, and falling back to the environment is the safe direction —
 * it's what every instance uses today.
 */
export async function loadIdentity(): Promise<void> {
  try {
    const rows = await prisma.siteSetting.findMany({ where: { key: { in: IDENTITY_KEYS } } });
    const found: Partial<Record<IdentityField, string>> = {};
    for (const row of rows) {
      const field = row.key.slice(KEY_PREFIX.length) as IdentityField;
      if (!FIELDS.includes(field)) continue;
      const value = clean(row.value);
      if (value) found[field] = value;
    }
    applyIdentityOverrides(found);

    if (Object.keys(found).length > 0) {
      // Loud on purpose: if this ever prints unexpectedly, the instance is
      // federating under an identity that is NOT what `.env.local` says, and
      // that is the first thing you'd want to know when debugging it.
      console.warn(
        `[FediHome] Federation identity overridden from the database: ${getIdentity().fediAddress} (${getIdentity().actorId})`,
      );
    }
  } catch {
    clearIdentityOverrides(); // DB unavailable → environment only
  }
}

/**
 * Re-read the overrides after a write.
 *
 * ⚠️ Process-local, like the load itself. Under a multi-process deployment
 * (pm2 cluster) only the worker that handled the write is refreshed; the others
 * keep serving the old identity until they restart. Whatever ships the write
 * path has to account for that — a partial rollout of a *federation identity*
 * across workers is exactly the silent-mismatch failure this module exists to
 * prevent.
 */
export async function refreshIdentity(): Promise<void> {
  await loadIdentity();
}
