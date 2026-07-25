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
 * Account aliases — `alsoKnownAs` (#326).
 *
 * This is the "I am also that account over there" half of a Fediverse move, and
 * it's what lets someone bring their followers TO a FediHome from somewhere
 * else. The old server publishes a `Move`; every receiving server then fetches
 * the *target* actor — us — and only re-points the follow if our `alsoKnownAs`
 * names the old account. Without this property the move is refused and the
 * followers stay put.
 *
 * Stored as one `identity.alsoKnownAs` row (whitespace/comma separated) rather
 * than in the sync accessor: only the actor document reads it, and that's
 * already an async context. `alsoKnownAs` is defined by the ActivityStreams
 * core context we already serve, so no JSON-LD changes are needed.
 */
export const ALSO_KNOWN_AS_KEY = "identity.alsoKnownAs";

/** Cap the list — this is a personal alias set, not a directory. */
const MAX_ALIASES = 10;

/**
 * Parse a stored/submitted alias list into absolute http(s) actor URIs.
 * Anything unparseable is dropped rather than emitted: a malformed entry in our
 * actor document is worse than a missing one, since it can make the whole
 * property unusable to a server verifying a move.
 */
export function parseAliases(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[\s,]+/)) {
    const v = piece.trim();
    if (!v) continue;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    // Character scan, not /\/+$/ — that backtracks quadratically on a long run
    // of slashes (js/polynomial-redos).
    let end = u.toString().length;
    const str = u.toString();
    while (end > 0 && str.charCodeAt(end - 1) === 47) end--;
    const normalized = str.slice(0, end);
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

/** The configured aliases, or `[]` — never throws, so the actor always serves. */
export async function getAlsoKnownAs(): Promise<string[]> {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: ALSO_KNOWN_AS_KEY } });
    return row ? parseAliases(row.value) : [];
  } catch {
    return [];
  }
}

/** Replace the alias list. Returns what was actually stored, after validation. */
export async function setAlsoKnownAs(raw: string): Promise<string[]> {
  const aliases = parseAliases(raw);
  const value = aliases.join("\n");
  await prisma.siteSetting.upsert({
    where: { key: ALSO_KNOWN_AS_KEY },
    update: { value },
    create: { key: ALSO_KNOWN_AS_KEY, value },
  });
  return aliases;
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
