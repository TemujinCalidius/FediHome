import { prisma } from "./db";
import { siteConfig } from "@/../site.config";

/**
 * The owner's runtime-editable profile (#201): the `SiteSettings` row (id
 * "main") overlaid on the `site.config.ts` env defaults. A null column falls
 * back to the env/default value, so an instance that never edits its profile
 * behaves exactly as before.
 *
 * Read on the AP actor + /api/account hot paths, so it's cached for 60s and
 * invalidated on save (invalidateProfileCache). A DB error falls back to the
 * env defaults (uncached) so the actor endpoint never hard-fails on it.
 */

export interface RuntimeProfile {
  authorName: string;
  authorBio: string;
  authorTagline: string;
  actorSummary: string;
  /** The DEFAULT theme's accent (legacy single value; what the macOS app reads). */
  accentColor: string;
  /** Per-theme accent overrides (#276): `{ [themeId]: "#rrggbb" }`. Absent theme = inherit. */
  themeAccents: Record<string, string>;
  avatarPath: string;
  bannerPath: string;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Defensively coerce the `themeAccents` Json column into `{ themeId: #rrggbb }`. */
function parseThemeAccents(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && HEX6.test(v)) out[k] = v.toLowerCase();
  }
  return out;
}

/** SiteSettings columns the profile editor may write. */
export const PROFILE_FIELDS = [
  "authorName",
  "authorBio",
  "authorTagline",
  "actorSummary",
  "accentColor",
  "avatarPath",
  "bannerPath",
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

function envDefaults(): RuntimeProfile {
  return {
    authorName: siteConfig.authorName,
    authorBio: siteConfig.authorBio,
    authorTagline: siteConfig.authorTagline,
    actorSummary: siteConfig.actorSummary,
    accentColor: "#3b82f6",
    themeAccents: {},
    avatarPath: siteConfig.avatarPath,
    bannerPath: siteConfig.bannerPath,
  };
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; profile: RuntimeProfile } | null = null;

/** Drop the cache — called after the owner saves so changes apply immediately. */
export function invalidateProfileCache(): void {
  cache = null;
}

export async function getRuntimeProfile(): Promise<RuntimeProfile> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.profile;

  const base = envDefaults();
  let profile = base;
  try {
    const row = await prisma.siteSettings.findUnique({ where: { id: "main" } });
    if (row) {
      profile = {
        authorName: row.authorName || base.authorName,
        authorBio: row.authorBio ?? base.authorBio,
        authorTagline: row.authorTagline ?? base.authorTagline,
        actorSummary: row.actorSummary || base.actorSummary,
        accentColor: row.accentColor || base.accentColor,
        themeAccents: parseThemeAccents(row.themeAccents),
        avatarPath: row.avatarPath || base.avatarPath,
        bannerPath: row.bannerPath || base.bannerPath,
      };
    }
  } catch {
    return base; // DB down/mid-migration — env defaults, don't cache the failure
  }

  cache = { at: Date.now(), profile };
  return profile;
}
