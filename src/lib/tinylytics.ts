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
