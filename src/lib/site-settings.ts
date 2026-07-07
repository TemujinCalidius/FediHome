import { prisma } from "./db";
import { siteConfig } from "@/../site.config";

/**
 * Runtime-editable site config (#59) — the safe display/feature settings,
 * overlaid on the `site.config.ts` env defaults from the `SiteSetting` KV table
 * (the scheduler's pattern). An override row beats the env default; deleting it
 * reverts. Read by the site's pages + the admin editor; 60s cache, invalidated
 * on save, env-fallback if the DB is unreachable.
 *
 * Deliberately EXCLUDES identity/secret config (SITE_URL, FEDI_HANDLE,
 * FEDI_DOMAIN, ADMIN_SECRET) — those are baked into the AP actor identity /
 * root auth and stay env-only (a host pre-sets them). Profile fields
 * (authorName/bio/avatar…) live in the separate SiteSettings overlay
 * (site-profile.ts, #201).
 */

export type FieldType = "bool" | "text" | "url";

/** Every editable key and its value type (drives validation + parsing). */
export const SITE_CONFIG_FIELDS: Record<string, FieldType> = {
  "site.name": "text",
  "site.description": "text",
  "landing.mode": "bool",
  "landing.headline": "text",
  "landing.subhead": "text",
  "landing.repoUrl": "url",
  "feed.public": "bool",
  "feed.publicTitle": "text",
  "feed.hideSocialGraph": "bool",
  "nav.journal": "bool",
  "nav.articles": "bool",
  "nav.photography": "bool",
  "nav.videos": "bool",
  "nav.audio": "bool",
  "nav.about": "bool",
  "footer.webringUrl": "url",
  "footer.webringLabel": "text",
  "footer.badgeSrc": "url",
  "footer.badgeHref": "url",
  "footer.badgeAlt": "text",
  "footer.fundingUrl": "url",
  "footer.fundingLabel": "text",
};

export const SITE_CONFIG_KEYS = Object.keys(SITE_CONFIG_FIELDS);

export interface RuntimeSiteConfig {
  name: string;
  description: string;
  landing: { mode: boolean; headline: string; subhead: string; repoUrl: string };
  publicFeed: boolean;
  publicFeedTitle: string;
  hideSocialGraph: boolean;
  nav: {
    showJournal: boolean; showArticles: boolean; showPhotography: boolean;
    showVideos: boolean; showAudio: boolean; showAbout: boolean;
  };
  footer: {
    webringUrl: string; webringLabel: string; badgeSrc: string; badgeHref: string;
    badgeAlt: string; fundingUrl: string; fundingLabel: string;
  };
}

/** The env/default view — exactly what `siteConfig` (env-driven) exposes today. */
export function siteConfigDefaults(): RuntimeSiteConfig {
  return {
    name: siteConfig.name,
    description: siteConfig.description,
    landing: {
      mode: siteConfig.landingMode,
      headline: siteConfig.landingHeadline,
      subhead: siteConfig.landingSubhead,
      repoUrl: siteConfig.repoUrl,
    },
    publicFeed: siteConfig.publicFeed,
    publicFeedTitle: siteConfig.publicFeedTitle,
    hideSocialGraph: siteConfig.hideSocialGraph,
    nav: { ...siteConfig.nav },
    footer: { ...siteConfig.footer },
  };
}

function boolOverride(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  return v === "true";
}

function textOverride(v: string | undefined, fallback: string): string {
  return v == null ? fallback : v;
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; cfg: RuntimeSiteConfig } | null = null;

/** Drop the cache — called after the admin saves so changes apply within a tick. */
export function invalidateSiteConfigCache(): void {
  cache = null;
}

/** Env defaults overlaid with `SiteSetting` overrides. Safe on hot paths (60s cache). */
export async function getRuntimeSiteConfig(): Promise<RuntimeSiteConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.cfg;

  const base = siteConfigDefaults();
  let cfg = base;
  try {
    const rows = await prisma.siteSetting.findMany({ where: { key: { in: SITE_CONFIG_KEYS } } });
    const o = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cfg = {
      name: textOverride(o["site.name"], base.name),
      description: textOverride(o["site.description"], base.description),
      landing: {
        mode: boolOverride(o["landing.mode"], base.landing.mode),
        headline: textOverride(o["landing.headline"], base.landing.headline),
        subhead: textOverride(o["landing.subhead"], base.landing.subhead),
        repoUrl: textOverride(o["landing.repoUrl"], base.landing.repoUrl),
      },
      publicFeed: boolOverride(o["feed.public"], base.publicFeed),
      publicFeedTitle: textOverride(o["feed.publicTitle"], base.publicFeedTitle),
      hideSocialGraph: boolOverride(o["feed.hideSocialGraph"], base.hideSocialGraph),
      nav: {
        showJournal: boolOverride(o["nav.journal"], base.nav.showJournal),
        showArticles: boolOverride(o["nav.articles"], base.nav.showArticles),
        showPhotography: boolOverride(o["nav.photography"], base.nav.showPhotography),
        showVideos: boolOverride(o["nav.videos"], base.nav.showVideos),
        showAudio: boolOverride(o["nav.audio"], base.nav.showAudio),
        showAbout: boolOverride(o["nav.about"], base.nav.showAbout),
      },
      footer: {
        webringUrl: textOverride(o["footer.webringUrl"], base.footer.webringUrl),
        webringLabel: textOverride(o["footer.webringLabel"], base.footer.webringLabel),
        badgeSrc: textOverride(o["footer.badgeSrc"], base.footer.badgeSrc),
        badgeHref: textOverride(o["footer.badgeHref"], base.footer.badgeHref),
        badgeAlt: textOverride(o["footer.badgeAlt"], base.footer.badgeAlt),
        fundingUrl: textOverride(o["footer.fundingUrl"], base.footer.fundingUrl),
        fundingLabel: textOverride(o["footer.fundingLabel"], base.footer.fundingLabel),
      },
    };
  } catch {
    return base; // DB down/mid-migration — env defaults, don't cache the failure
  }

  cache = { at: Date.now(), cfg };
  return cfg;
}
