/**
 * FediHome — Site Configuration
 *
 * These values configure your FediHome instance.
 * Most are set during the setup wizard and stored in .env.local.
 * You can also edit them directly here or via the admin panel.
 */

const siteUrl = process.env.SITE_URL || "http://localhost:3000";
const fediHandle = process.env.FEDI_HANDLE || "me";
const fediDomain = process.env.FEDI_DOMAIN || new URL(siteUrl).hostname;

export const siteConfig = {
  // Site identity
  name: process.env.SITE_NAME || "My FediHome",
  url: siteUrl,
  description: process.env.SITE_DESCRIPTION || "A personal space on the Fediverse.",

  // Author
  authorName: process.env.AUTHOR_NAME || "Your Name",
  authorBio: process.env.AUTHOR_BIO || "",
  authorTagline: process.env.AUTHOR_TAGLINE || "",
  contactEmail: process.env.CONTACT_EMAIL || "",

  // Fediverse identity
  fediHandle,
  fediDomain,
  fediAddress: `@${fediHandle}@${fediDomain}`,
  actorSummary: process.env.ACTOR_SUMMARY || "A personal blog on the Fediverse, powered by FediHome.",

  // Public landing / showcase mode.
  // When LANDING_MODE=true, the homepage becomes a project-style landing page
  // (hero + feature highlights + CTAs) instead of the personal blog intro.
  // Off by default, so existing personal sites are completely unaffected.
  landingMode: process.env.LANDING_MODE === "true",
  landingHeadline:
    process.env.LANDING_HEADLINE || "Your home on the open social web",
  landingSubhead:
    process.env.LANDING_SUBHEAD ||
    "FediHome is a self-hosted personal site that speaks ActivityPub — your blog, photos, videos and a live Fediverse feed, all owned by you and federated with Mastodon and the wider network.",
  repoUrl: process.env.REPO_URL || "https://github.com/TemujinCalidius/fedihome",

  // Public read-only Fediverse feed. When PUBLIC_FEED=true, /fediverse shows a
  // login-free, read-only window into the accounts this site follows — no admin
  // access and no like/boost/reply. Off by default.
  publicFeed: process.env.PUBLIC_FEED === "true",
  publicFeedTitle: process.env.PUBLIC_FEED_TITLE || "The Fediverse feed",

  // When HIDE_SOCIAL_GRAPH=true, /ap/followers and /ap/following still report
  // their counts (totalItems) but don't enumerate members — Mastodon's
  // hidden-collection behaviour. Off by default.
  hideSocialGraph: process.env.HIDE_SOCIAL_GRAPH === "true",

  // Assets
  avatarPath: "/images/avatar.png",
  bannerPath: "/images/banner.webp",
  ogImagePath: "/images/og-image.webp",

  // Navigation visibility. Each section shows unless its env var is "false",
  // so existing sites keep every link. Lets a deployment hide sections it
  // doesn't use (e.g. the demo) without editing code.
  nav: {
    showJournal: process.env.NAV_SHOW_JOURNAL !== "false",
    showArticles: process.env.NAV_SHOW_ARTICLES !== "false",
    showPhotography: process.env.NAV_SHOW_PHOTOGRAPHY !== "false",
    showVideos: process.env.NAV_SHOW_VIDEOS !== "false",
    showAudio: process.env.NAV_SHOW_AUDIO !== "false",
    showAbout: process.env.NAV_SHOW_ABOUT !== "false",
  },

  // Footer extras — all optional. The webring link and badge only render when
  // configured, so the default footer carries no personal links. Copyright,
  // handle and email come from authorName / fediAddress / contactEmail above.
  footer: {
    webringUrl: process.env.WEBRING_URL || "",
    webringLabel: process.env.WEBRING_LABEL || "Webring",
    badgeSrc: process.env.FOOTER_BADGE_SRC || "",
    badgeHref: process.env.FOOTER_BADGE_HREF || "",
    badgeAlt: process.env.FOOTER_BADGE_ALT || "Badge",
    fundingUrl: process.env.FUNDING_URL || "",
    fundingLabel: process.env.FUNDING_LABEL || "Support FediHome",
  },

  // Native-app downloads (#241). When DOWNLOAD_MACOS_ENABLED=true, a "Download"
  // nav link, a homepage hero CTA, and a /download page appear — a marketing
  // surface for the FediHome macOS app. Off by default so a personal instance
  // isn't advertising an app it may not use; the public demo turns it on. The
  // release URL tracks GitHub Releases "latest" (always the newest notarized
  // build); the App Store URL is an empty slot until the listing is approved.
  download: {
    macosEnabled: process.env.DOWNLOAD_MACOS_ENABLED === "true",
    macosReleaseUrl:
      process.env.DOWNLOAD_MACOS_RELEASE_URL ||
      "https://github.com/TemujinCalidius/FediHome-macOS/releases/latest",
    macosAppStoreUrl: process.env.DOWNLOAD_MACOS_APP_STORE_URL || "",
  },
} as const;

export type SiteConfig = typeof siteConfig;
