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

  // Assets
  avatarPath: "/images/avatar.png",
  bannerPath: "/images/banner.webp",
  ogImagePath: "/images/og-image.webp",

  // Navigation
  nav: {
    showJournal: true,
    showArticles: true,
    showPhotography: true,
    showAbout: true,
  },
} as const;

export type SiteConfig = typeof siteConfig;
