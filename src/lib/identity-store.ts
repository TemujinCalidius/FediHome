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
 * **Writable only before an instance has published (#326).** `setIdentity()`
 * exists now, but it refuses once anything durable carries the current identity.
 * That guard is not conservatism — `Post`/`Photo`/`Video`/`Audio`/`DirectMessage`
 * `.apId` are `@unique` ABSOLUTE URLs built from `SITE_URL`, and remote servers
 * keep the first actor id they ever saw. Rewriting them is not a migration we
 * can do safely, because the copies that matter aren't ours.
 *
 * Changing domains after that point needs the real ActivityPub answer —
 * `alsoKnownAs` plus a `Move` served from the OLD instance while it is still
 * reachable (#347) — not a settings field.
 */

const KEY_PREFIX = "identity.";
const FIELDS = ["siteUrl", "fediHandle", "fediDomain"] as const;
type IdentityField = (typeof FIELDS)[number];

export const IDENTITY_KEYS = FIELDS.map((f) => `${KEY_PREFIX}${f}`);

export const HANDLE_RE = /^[a-zA-Z0-9_]{1,30}$/;
export const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/**
 * Shape check for a site URL: a bare http(s) origin, no credentials, no path.
 *
 * Deliberately does NOT include the reachability check (#431). That one belongs
 * to what an operator can SET, not to what we can load — a developer who points
 * a local instance at http://localhost:3000 by hand has done something
 * deliberate, and silently reverting it to the environment with nothing in the
 * logs would be the same class of unexplained behaviour this is trying to
 * remove. The admin route layers `isLocalOrPrivateHost` on top for the set path.
 */
export function siteUrlShape(input: string): string | undefined {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  if (u.username || u.password) return undefined;
  if (u.pathname !== "/" || u.search || u.hash) return undefined;
  return u.origin;
}

/**
 * Reject junk so a bad row can't produce a malformed actor id.
 *
 * The docstring above said exactly this before #431 — it just didn't reject
 * enough to achieve it. The checks were type, non-empty, length and whitespace,
 * while `validateSiteUrl` lived in the admin ROUTE. So any row written by
 * something other than that route — a manual psql edit, a restore, a future
 * migration or script — flowed straight into getIdentity().siteUrl, and from
 * there into the actor id, the keyId, and every published post's apId. A row of
 * `not a url` produced an actor id of `not a url/ap/actor`, which the instance
 * then published under.
 *
 * Field-aware now, and the rules are the same objects the route uses, so there
 * is one rule set rather than two that can drift.
 */
function clean(value: unknown, field?: IdentityField): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.length > 300 || /[\s\r\n]/.test(v)) return undefined;
  if (field === "siteUrl") return siteUrlShape(v);
  if (field === "fediHandle") return HANDLE_RE.test(v) ? v : undefined;
  if (field === "fediDomain") {
    const lower = v.toLowerCase();
    return DOMAIN_RE.test(lower) ? lower : undefined;
  }
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
      const value = clean(row.value, field);
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

/* -------------------------- Writing identity (#326) ------------------------- */

/**
 * Anything that would be stranded by a change of identity.
 *
 * Deliberately NOT `looksEstablished()` (federation.ts), which asks a softer
 * question for a different purpose. The honest test here is "has anything
 * durable been stamped with the current identity?", because those stamps are
 * `@unique` absolute URLs that a rename would orphan — and because a remote
 * server that has seen our actor id keeps it forever.
 *
 * The keypair is deliberately absent from this list: `ActorKeys` stores no URL
 * and `keyId` is derived at use time, so it re-anchors to a new identity by
 * itself.
 */
export async function identityIsLocked(): Promise<{ locked: boolean; reason?: string }> {
  try {
    const [posts, photos, videos, audio, dms, outgoing, followers, following] = await Promise.all([
      prisma.post.count({ where: { apId: { not: null } } }),
      prisma.photo.count({ where: { apId: { not: null } } }),
      prisma.video.count({ where: { apId: { not: null } } }),
      prisma.audio.count({ where: { apId: { not: null } } }),
      prisma.directMessage.count({ where: { isOutgoing: true } }),
      prisma.fediPost.count({ where: { isOutgoing: true } }),
      prisma.fediFollower.count(),
      prisma.fediFollowing.count(),
    ]);

    const published = posts + photos + videos + audio + outgoing + dms;
    if (published > 0) {
      return {
        locked: true,
        reason:
          `This instance has already published ${published} item${published === 1 ? "" : "s"} under its current address. ` +
          "Every one of them carries that address inside it, and other servers keep the first one they saw — so changing it " +
          "now would orphan them rather than move them. Moving to a new domain needs an account migration (#347), not a setting.",
      };
    }
    if (followers > 0) {
      return {
        locked: true,
        reason:
          `${followers} account${followers === 1 ? " follows" : "s follow"} you at the current address. ` +
          "Changing it would silently break those follows, with nothing on their side to explain why your posts stopped.",
      };
    }
    // The OUTBOUND direction, which this check missed entirely (#428). Their
    // servers recorded our current actor id as a follower the moment we sent the
    // Follow, and we publish the list at /ap/following under that same id. Change
    // it and every one of them keeps delivering to an address that no longer
    // resolves — we simply stop receiving, with nothing on either side to say why,
    // while our own Following list still insists the follows are fine.
    if (following > 0) {
      return {
        locked: true,
        reason:
          `You follow ${following} account${following === 1 ? "" : "s"} from the current address. ` +
          "Their servers deliver to that address, so changing it would silently stop everything they post " +
          "from reaching you — and no Undo was ever sent, so nothing on their side would explain it either.",
      };
    }
    return { locked: false };
  } catch {
    // Can't prove it's safe, so don't allow it.
    return { locked: true, reason: "Couldn't check whether this instance has published yet — try again in a moment." };
  }
}

export type IdentityPatch = Partial<Record<IdentityField, string>>;

/**
 * Write the `identity.*` overrides.
 *
 * Callers MUST check `identityIsLocked()` first; this function does not, so the
 * setup path can use it before anything exists to check. An empty string clears
 * a field back to the environment value.
 *
 * The caller is also responsible for `refreshIdentity()` — and for telling the
 * owner that a restart is the only way to be sure, since the overrides are
 * process-local (see below).
 */
export async function setIdentity(patch: IdentityPatch): Promise<void> {
  for (const field of FIELDS) {
    const raw = patch[field];
    if (raw === undefined) continue;
    const key = `${KEY_PREFIX}${field}`;
    if (raw.trim() === "") {
      await prisma.siteSetting.deleteMany({ where: { key } });
      continue;
    }
    const value = clean(raw, field);
    if (value === undefined) throw new Error(`Invalid value for ${field}`);
    await prisma.siteSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
}
