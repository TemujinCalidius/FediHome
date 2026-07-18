/**
 * Tinylytics API helper — server-side only.
 * API key never exposed to the browser.
 */

const API_BASE = "https://tinylytics.app/api/v1";
const API_KEY = process.env.TINYLYTICS_API_KEY;
const SITE_ID = process.env.TINYLYTICS_SITE_ID;

async function tlFetch(endpoint: string): Promise<unknown> {
  if (!API_KEY || !SITE_ID) return null;
  const res = await fetch(`${API_BASE}/sites/${SITE_ID}${endpoint}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    next: { revalidate: 300 }, // cache 5 minutes
  });
  if (!res.ok) return null;
  return res.json();
}

/** Total lifetime hits for the site */
export async function getSiteStats(): Promise<{ totalHits: number; totalKudos: number } | null> {
  if (!API_KEY || !SITE_ID) return null;
  const res = await fetch(`${API_BASE}/sites/${SITE_ID}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    next: { revalidate: 300 },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { lifetime_hits: number; lifetime_kudos: number };
  return { totalHits: data.lifetime_hits, totalKudos: data.lifetime_kudos };
}

/** View count for a specific path */
export async function getPathHits(path: string): Promise<number> {
  const data = (await tlFetch("/leaderboard")) as { leaderboard: { path: string; total_hits: number }[] } | null;
  if (!data) return 0;
  const entry = data.leaderboard.find((e) => e.path === path || e.path === path + "/");
  return entry?.total_hits || 0;
}

/** Top pages by views */
export async function getLeaderboard(limit = 10): Promise<{ path: string; hits: number; percentage: number }[]> {
  const data = (await tlFetch("/leaderboard")) as { leaderboard: { path: string; total_hits: number; percentage: number }[] } | null;
  if (!data) return [];
  return data.leaderboard.slice(0, limit).map((e) => ({
    path: e.path,
    hits: e.total_hits,
    percentage: e.percentage,
  }));
}

/** Send a kudos for a path */
export async function createKudos(path: string): Promise<boolean> {
  if (!API_KEY || !SITE_ID) return false;
  const res = await fetch(`${API_BASE}/sites/${SITE_ID}/kudos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path }),
  });
  return res.ok;
}

/** Get kudos count for a specific path */
export async function getKudosForPath(path: string): Promise<number> {
  const data = (await tlFetch(`/kudos?path=${encodeURIComponent(path)}`)) as { kudos: unknown[]; pagination: { total_count: number } } | null;
  if (!data) return 0;
  return data.pagination.total_count;
}

/** Check if Tinylytics is configured */
export function isTinylyticsConfigured(): boolean {
  return !!(process.env.TINYLYTICS_API_KEY && process.env.TINYLYTICS_SITE_ID);
}

/* --- Collecting-embed code resolution (#288) ------------------------------- */
// The on-page COLLECTING embed loads `tinylytics.app/embed/<code>.js`, and that
// endpoint needs the site's `uid` — NOT the numeric site id. A numeric id 404s
// and silently records zero pageviews. The numeric id is only correct for the
// API reads above (/sites/{id}). So resolve the embed code as: an explicit
// override → a site id that's already a uid → else derive the uid from the API.

const NUMERIC = /^\d+$/;
type UidEntry = { uid: string | null; at: number };
const uidCache = new Map<string, UidEntry>();
const UID_OK_TTL = Infinity; // a site's uid is immutable
const UID_FAIL_TTL = 60_000; // retry an unresolved lookup after a minute

/**
 * Resolve a numeric Tinylytics site id to its embed `uid` via the API (needs the
 * API key). Cached in-memory (the uid never changes) since this runs on the root
 * layout's render path; a failure is cached only briefly so it self-heals.
 */
export async function getSiteUid(siteId: string): Promise<string | null> {
  const hit = uidCache.get(siteId);
  if (hit && Date.now() - hit.at < (hit.uid ? UID_OK_TTL : UID_FAIL_TTL)) return hit.uid;

  const apiKey = process.env.TINYLYTICS_API_KEY;
  if (!apiKey) return null; // can't derive without the API key — caller warns/surfaces

  let uid: string | null = null;
  try {
    const res = await fetch(`${API_BASE}/sites/${encodeURIComponent(siteId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store", // we do our own caching
      signal: AbortSignal.timeout(4000), // never block the render on a slow API
    });
    if (res.ok) uid = (((await res.json()) as { uid?: string }).uid || null);
  } catch {
    /* network/timeout → unresolved; retry after UID_FAIL_TTL */
  }
  if (!uid) {
    console.warn(
      `[tinylytics] could not resolve an embed uid for site id "${siteId}" — pageviews are NOT being collected. Set TINYLYTICS_API_KEY, or enter the embed code (uid) directly.`,
    );
  }
  uidCache.set(siteId, { uid, at: Date.now() });
  return uid;
}

/**
 * The code for the collecting embed, from the analytics config (#288):
 *   1. an explicit embed id (already the uid) — override;
 *   2. a site id that already looks like a uid (non-numeric) — used as-is;
 *   3. a numeric site id — derived to the uid via the API;
 *   else `null` (we deliberately never emit a numeric id — it 404s silently).
 */
export async function resolveTinylyticsEmbed(analytics: { siteId: string; embedId: string } | null | undefined): Promise<string | null> {
  const embedId = analytics?.embedId?.trim();
  if (embedId) return embedId;
  const siteId = analytics?.siteId?.trim();
  if (!siteId) return null;
  if (!NUMERIC.test(siteId)) return siteId; // already a uid
  return getSiteUid(siteId);
}

/** Raw hit from the API */
export interface RawHit {
  id: number;
  path: string;
  referrer: string;
  country: string;
  browser_name: string;
  platform_name: string;
  created_at: string;
}

/** User journey from the API */
export interface UserJourney {
  visitor_hash: string;
  page_count: number;
  pages: { path: string }[];
  entry_page: string;
  exit_page: string;
  session_duration: string;
  referrer: string;
  country: string;
  browser: string;
  first_hit: string;
}

/** Get recent raw hits for aggregation */
export async function getRecentHits(perPage = 100): Promise<RawHit[]> {
  const data = (await tlFetch(`/hits?per_page=${perPage}`)) as { hits: RawHit[] } | null;
  return data?.hits || [];
}

/** Get user journeys */
export async function getUserJourneys(limit = 15): Promise<UserJourney[]> {
  const data = (await tlFetch(`/user_journeys?per_page=${limit}`)) as { user_journeys: UserJourney[] } | null;
  return data?.user_journeys || [];
}
