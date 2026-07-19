import { prisma } from "./db";
import { encryptSecret, decryptSecret } from "./secret-box";

/**
 * The Tinylytics **API key** (#59), configurable in the admin panel so the in-app
 * analytics dashboard / kudos / leaderboard need no `.env` editing. The key is a
 * secret, so it's stored AES-256-GCM-encrypted (see secret-box, key derived from
 * ADMIN_SECRET) — a DB leak alone can't reveal it.
 *
 * Stored as a single `SiteSetting` row under the `integration.*` namespace,
 * DELIBERATELY NOT part of `SITE_CONFIG_KEYS` — so it's never returned by the
 * site-config admin GET nor writable via `applySiteConfig`. Access is ONLY through
 * this module + the dedicated /api/admin/analytics-key route, which never returns
 * the key to the client (mirrors the crosspost integrations pattern).
 *
 * Reads fall back to the legacy `TINYLYTICS_API_KEY` env var, so instances
 * configured the old way keep working; a saved DB key takes precedence.
 */

const KEY = "integration.tinylytics.apiKey"; // encrypted

async function readRow(): Promise<string | undefined> {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
    return row?.value;
  } catch {
    return undefined; // DB down/mid-migration → fall back to env
  }
}

/** The Tinylytics API key: the saved (decrypted) DB value, else the env var. */
export async function getTinylyticsApiKey(): Promise<string | null> {
  const stored = await readRow();
  if (stored) {
    const dec = decryptSecret(stored);
    if (dec) return dec;
  }
  return process.env.TINYLYTICS_API_KEY || null;
}

export async function setTinylyticsApiKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const enc = encryptSecret(apiKey);
  if (!enc) return { ok: false, error: "Encryption unavailable — ADMIN_SECRET is not set." };
  await prisma.siteSetting.upsert({ where: { key: KEY }, update: { value: enc }, create: { key: KEY, value: enc } });
  return { ok: true };
}

/** Clear the DB override (reverts to the env var if set). */
export async function clearTinylyticsApiKey(): Promise<void> {
  await prisma.siteSetting.deleteMany({ where: { key: KEY } });
}

/** Admin-panel status — never returns the key itself. */
export async function getAnalyticsKeyStatus(): Promise<{ configured: boolean; source: "db" | "env" | null }> {
  const stored = await readRow();
  const db = !!(stored && decryptSecret(stored)); // a rotated ADMIN_SECRET → won't decrypt → not "configured" from db
  const env = !!process.env.TINYLYTICS_API_KEY;
  return { configured: db || env, source: db ? "db" : env ? "env" : null };
}
