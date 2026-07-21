import { prisma } from "./db";
import { siteConfig } from "@/../site.config";
import { isThemeId, isFeedVariant, isHeaderVariant, isFooterVariant, isShellVariant } from "./themes";
import { parseCategoryList, resolveCategoryList, MAX_CATEGORIES } from "./categories";
import {
  parseSidebarBlocks, resolveSidebarBlocks, isSidebarSide, isSidebarBlock,
  type SidebarSide, type SidebarBlock,
} from "./sidebar";

const SLUG = /^[a-z0-9-]+$/;

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
  "download.macos.enabled": "bool",
  "download.macos.releaseUrl": "url",
  "download.macos.appStoreUrl": "url",
  "theme.id": "text", // validated against the theme registry (see validateSiteConfigValue)
  "layout.feed": "text", // "" (inherit theme) or a known feed variant (see validateSiteConfigValue)
  "layout.header": "text", // "" (inherit theme) or a known header variant (see validateSiteConfigValue)
  "layout.footer": "text", // "" (inherit theme) or a known footer variant (see validateSiteConfigValue)
  "layout.shell": "text", // "" (inherit theme) or a known shell variant (see validateSiteConfigValue)
  "sidebar.side": "text", // "" (default right) or left|right (#307)
  "sidebar.blocks": "text", // ordered CSV of known blocks; "" = built-in order (#307)
  "contact.email": "text",
  "podcast.title": "text",
  "podcast.author": "text",
  "podcast.description": "text",
  "podcast.email": "text",
  "podcast.image": "url",
  "categories.photos": "text", // comma-separated slugs; "" = built-in defaults (see validateSiteConfigValue)
  "categories.videos": "text",
  "categories.audio": "text",
  "analytics.siteId": "text",
  "analytics.embedId": "text",
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
  download: { macosEnabled: boolean; macosReleaseUrl: string; macosAppStoreUrl: string };
  theme: { id: string };
  layout: { feed: string; header: string; footer: string; shell: string };
  /** Sidebar options (#307) — only meaningful when the shell variant is "sidebar". */
  sidebar: { side: SidebarSide; blocks: SidebarBlock[] };
  contact: { email: string };
  // /audio podcast feed overrides — empty means "derive from your profile".
  podcast: { title: string; author: string; description: string; email: string; image: string };
  // Resolved gallery category lists (#284) — always non-empty, always incl. "general".
  categories: { photos: string[]; videos: string[]; audio: string[] };
  // Tinylytics public embed ids (#59). API key stays env-only.
  analytics: { siteId: string; embedId: string };
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
    download: { ...siteConfig.download },
    theme: { ...siteConfig.theme },
    layout: { ...siteConfig.layout },
    sidebar: {
      side: isSidebarSide(siteConfig.sidebar.side) ? siteConfig.sidebar.side : "right",
      blocks: resolveSidebarBlocks(parseSidebarBlocks(siteConfig.sidebar.blocks)),
    },
    contact: { email: siteConfig.contactEmail },
    podcast: { ...siteConfig.podcast },
    categories: {
      photos: resolveCategoryList(parseCategoryList(siteConfig.categories.photos), "photos"),
      videos: resolveCategoryList(parseCategoryList(siteConfig.categories.videos), "videos"),
      audio: resolveCategoryList(parseCategoryList(siteConfig.categories.audio), "audio"),
    },
    analytics: { ...siteConfig.analytics },
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
      download: {
        macosEnabled: boolOverride(o["download.macos.enabled"], base.download.macosEnabled),
        macosReleaseUrl: textOverride(o["download.macos.releaseUrl"], base.download.macosReleaseUrl),
        macosAppStoreUrl: textOverride(o["download.macos.appStoreUrl"], base.download.macosAppStoreUrl),
      },
      theme: { id: textOverride(o["theme.id"], base.theme.id) },
      layout: {
        feed: textOverride(o["layout.feed"], base.layout.feed),
        header: textOverride(o["layout.header"], base.layout.header),
        footer: textOverride(o["layout.footer"], base.layout.footer),
        shell: textOverride(o["layout.shell"], base.layout.shell),
      },
      contact: { email: textOverride(o["contact.email"], base.contact.email) },
      podcast: {
        title: textOverride(o["podcast.title"], base.podcast.title),
        author: textOverride(o["podcast.author"], base.podcast.author),
        description: textOverride(o["podcast.description"], base.podcast.description),
        email: textOverride(o["podcast.email"], base.podcast.email),
        image: textOverride(o["podcast.image"], base.podcast.image),
      },
      // Sidebar side + ordered block list (#307); empty → right / built-in order.
      sidebar: {
        side: ((): SidebarSide => {
          const v = o["sidebar.side"] ?? siteConfig.sidebar.side;
          return isSidebarSide(v) ? v : "right";
        })(),
        blocks: resolveSidebarBlocks(parseSidebarBlocks(o["sidebar.blocks"] ?? siteConfig.sidebar.blocks)),
      },
      // Resolve the override CSV (else the env CSV) into a slug list; empty → defaults.
      categories: {
        photos: resolveCategoryList(parseCategoryList(o["categories.photos"] ?? siteConfig.categories.photos), "photos"),
        videos: resolveCategoryList(parseCategoryList(o["categories.videos"] ?? siteConfig.categories.videos), "videos"),
        audio: resolveCategoryList(parseCategoryList(o["categories.audio"] ?? siteConfig.categories.audio), "audio"),
      },
      analytics: {
        siteId: textOverride(o["analytics.siteId"], base.analytics.siteId),
        embedId: textOverride(o["analytics.embedId"], base.analytics.embedId),
      },
    };
  } catch {
    return base; // DB down/mid-migration — env defaults, don't cache the failure
  }

  cache = { at: Date.now(), cfg };
  return cfg;
}

/* ------------------------- validate + persist ------------------------- */

const KEY_SET = new Set<string>(SITE_CONFIG_KEYS);
const MAX_TEXT = 500;
const CONTROL = /[\r\n]/;

/**
 * Validate one field's value against its declared type. Returns the accepted
 * value or null if invalid. Empty string is allowed (clears a text/url field to
 * its "unset" state). URLs must be same-origin-relative or absolute http(s) —
 * never javascript:/data: (footer.badgeSrc is an <img> src).
 */
export function validateSiteConfigValue(key: string, value: string): string | null {
  const type = SITE_CONFIG_FIELDS[key];
  if (type === "bool") return value === "true" || value === "false" ? value : null;
  if (value.length > MAX_TEXT || CONTROL.test(value)) return null;
  if (key === "theme.id") return isThemeId(value) ? value : null; // must be a known theme
  if (key === "layout.feed") return value === "" || isFeedVariant(value) ? value : null; // "" inherits the theme
  if (key === "layout.header") return value === "" || isHeaderVariant(value) ? value : null; // "" inherits the theme
  if (key === "layout.footer") return value === "" || isFooterVariant(value) ? value : null; // "" inherits the theme
  if (key === "layout.shell") return value === "" || isShellVariant(value) ? value : null; // "" inherits the theme
  if (key === "sidebar.side") return value === "" || isSidebarSide(value) ? value : null; // "" = right
  if (key === "sidebar.blocks") {
    // "" = built-in order. Else an ordered CSV of KNOWN blocks — reject unknown
    // names rather than silently dropping them, so a typo surfaces at save time
    // instead of quietly hiding a block.
    if (value.trim() === "") return "";
    const tokens = value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.length === 0 || !tokens.every((t) => isSidebarBlock(t))) return null;
    return [...new Set(tokens)].join(",");
  }
  if (key === "categories.photos" || key === "categories.videos" || key === "categories.audio") {
    // "" = built-in defaults. Else comma-separated URL-safe slugs, deduped, capped.
    if (value.trim() === "") return "";
    const tokens = value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.length === 0 || tokens.length > MAX_CATEGORIES) return null;
    if (!tokens.every((t) => SLUG.test(t))) return null; // reject non-slug tokens (spaces, punctuation)
    return [...new Set(tokens)].join(",");
  }
  if (type === "url") {
    if (value === "") return value;
    if (value.startsWith("/") && !value.startsWith("//")) return value;
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:" ? value : null;
    } catch {
      return null;
    }
  }
  return value; // text
}

/**
 * Validate a partial `{ key: value | null }` map and persist it to `SiteSetting`
 * (upsert overrides; `null` deletes → revert to env), then invalidate the cache.
 * Shared by the admin editor (#59) and the first-run setup wizard. Validate-all
 * before write-any, so a bad key/value rejects the whole batch atomically.
 */
export async function applySiteConfig(
  settings: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { ok: false, error: "settings object required" };
  }
  const entries = Object.entries(settings as Record<string, unknown>);
  if (entries.length === 0 || entries.length > SITE_CONFIG_KEYS.length) {
    return { ok: false, error: "invalid settings payload" };
  }

  const writes: Array<{ key: string; value: string | null }> = [];
  for (const [key, raw] of entries) {
    if (!KEY_SET.has(key)) return { ok: false, error: `unknown setting: ${key}` };
    if (raw === null) {
      writes.push({ key, value: null });
      continue;
    }
    if (typeof raw !== "string") return { ok: false, error: `${key} must be a string or null` };
    const valid = validateSiteConfigValue(key, raw);
    if (valid === null) return { ok: false, error: `invalid value for ${key}` };
    writes.push({ key, value: valid });
  }

  for (const { key, value } of writes) {
    if (value === null) await prisma.siteSetting.deleteMany({ where: { key } });
    else await prisma.siteSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }

  invalidateSiteConfigCache();
  return { ok: true };
}
