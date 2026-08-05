import { prisma } from "./db";
import { getClient, isSafeRedirectScheme, type OAuthClient } from "./oauth";
import { isUrlClientId, resolveUrlClient } from "./indieauth-client";

/**
 * Registered third-party OAuth clients (#366).
 *
 * Kept OUT of `src/lib/oauth.ts` on purpose: that module is pure, synchronous
 * and prisma-free, and both halves of the exchange import it. This is the only
 * part that needs a database.
 */

/** Clamps, so a registration can't become a denial-of-service by size. */
const MAX_REDIRECT_URIS = 10;
const MAX_LABEL = 100;
const CLIENT_ID_RE = /^[a-zA-Z0-9._:\/-]{3,200}$/;

/**
 * In-memory negative cache for unknown client ids.
 *
 * THE REASON, and it is not premature. `GET /api/oauth/authorize` has no rate
 * limit — `authorizeLimiter` is wired into POST only — and that is safe today
 * precisely because an unknown `client_id` costs ZERO queries: `getClient` is a
 * pure array lookup. A database-backed resolver turns every unknown id into a
 * query, pre-auth and unmetered, on an endpoint `layout.tsx` advertises to the
 * entire web via `rel="authorization_endpoint"`.
 *
 * So an id that missed is remembered as missing for a minute. A registration
 * made in that window takes up to 60s to take effect, which is stated in the
 * admin UI; the alternative is handing anyone a database query per request.
 */
const MISS_TTL_MS = 60_000;
const misses = new Map<string, number>();

/** Bounded, so a flood of distinct ids can't grow the map without limit. */
const MAX_MISSES = 500;

export function resetClientCache(): void {
  misses.clear();
}

/**
 * Resolve a client id to a client, first-party or registered.
 *
 * First-party is checked FIRST and without a query, so the common path is
 * unchanged and a registration can never shadow a shipped app id.
 */
export async function resolveClient(
  clientId: string | null | undefined,
  /**
   * The caller's rate-limit key, needed only for the IndieAuth branch (#494),
   * which makes an outbound fetch. Omitted → that branch is skipped entirely,
   * so nothing that doesn't pass a key can be walked into a fetch.
   */
  rateKey?: string,
): Promise<OAuthClient | null> {
  if (!clientId) return null;

  const firstParty = getClient(clientId);
  if (firstParty) return firstParty;

  // A URL client id is checked BEFORE the registration table and before
  // CLIENT_ID_RE (#494). Two reasons: a URL contains characters that regexp
  // doesn't allow, so it would be refused before ever being tried; and a URL id
  // is authenticated by its own document, so there is nothing for a registration
  // to add. An owner who registers a URL id anyway still wins the tie below,
  // because this returns null on any fetch failure rather than swallowing it.
  if (rateKey && isUrlClientId(clientId)) {
    const viaUrl = await resolveUrlClient(clientId, rateKey);
    if (viaUrl) return viaUrl;
  }

  if (!CLIENT_ID_RE.test(clientId)) return null;

  const missedAt = misses.get(clientId);
  if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return null;

  let row;
  try {
    row = await prisma.oAuthClientRegistration.findFirst({ where: { clientId } });
  } catch {
    // A database problem must not authorise anything.
    return null;
  }

  if (!row) {
    if (misses.size >= MAX_MISSES) misses.clear();
    misses.set(clientId, Date.now());
    return null;
  }

  return {
    id: row.clientId,
    label: row.label,
    kind: "registered",
    redirectUris: row.redirectUris,
    redirectSchemes: row.redirectUris,
    // Registered clients get no loopback wildcard. A first-party app's loopback
    // path is fixed and known; a registered one would be the owner asserting a
    // whole port range, which is more than they were asked to assert.
    allowLoopback: false,
    loopbackPath: "",
  } as OAuthClient;
}

export interface RegisterResult {
  ok: boolean;
  error?: string;
}

export async function registerClient(
  clientId: string,
  label: string,
  redirectUris: string[],
): Promise<RegisterResult> {
  const id = clientId.trim();
  const name = label.trim();
  if (!CLIENT_ID_RE.test(id)) return { ok: false, error: "Client ID must be 3–200 characters, letters/digits/._:/- only." };
  if (getClient(id)) return { ok: false, error: "That ID belongs to a built-in FediHome app." };
  if (!name || name.length > MAX_LABEL) return { ok: false, error: "Give it a name (100 characters or fewer)." };

  const uris = redirectUris.map((u) => u.trim()).filter(Boolean);
  if (uris.length === 0) return { ok: false, error: "Add at least one redirect URI." };
  if (uris.length > MAX_REDIRECT_URIS) return { ok: false, error: `At most ${MAX_REDIRECT_URIS} redirect URIs.` };
  for (const u of uris) {
    // The same predicate validateRedirectUri uses, so the two cannot disagree
    // about what is safe.
    if (!isSafeRedirectScheme(u)) return { ok: false, error: `Not a usable redirect URI: ${u}` };
    if (u.length > 500) return { ok: false, error: "That redirect URI is too long." };
  }

  // Uniqueness is enforced here, not by a constraint — see the schema comment.
  const existing = await prisma.oAuthClientRegistration.findFirst({ where: { clientId: id } });
  if (existing) return { ok: false, error: "A client with that ID is already registered." };

  await prisma.oAuthClientRegistration.create({ data: { clientId: id, label: name, redirectUris: uris } });
  // A previously-missing id is now present; the negative cache would otherwise
  // keep refusing it for up to a minute.
  misses.delete(id);
  return { ok: true };
}

export async function unregisterClient(id: string): Promise<void> {
  const row = await prisma.oAuthClientRegistration.findUnique({ where: { id } });
  await prisma.oAuthClientRegistration.delete({ where: { id } }).catch(() => {});
  // Drop it from the POSITIVE side too — there isn't one, but a stale negative
  // entry for this id would be wrong in the other direction after a re-add.
  if (row) misses.delete(row.clientId);
}

export async function listClients() {
  return prisma.oAuthClientRegistration.findMany({ orderBy: { createdAt: "desc" } });
}
