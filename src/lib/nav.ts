import type { RuntimeSiteConfig } from "@/lib/site-settings";

export interface NavLink {
  label: string;
  href: string;
}

/**
 * Visible nav links, derived from the runtime site config's nav-visibility
 * toggles + public-feed flag (#59 — was a static env-derived constant).
 *
 * Call from a SERVER component with `getRuntimeSiteConfig()`; pass the result
 * to client components (e.g. MobileMenu) as a prop rather than importing this.
 */
export function buildNavLinks(cfg: RuntimeSiteConfig): NavLink[] {
  return [
    { label: "Home", href: "/" },
    ...(cfg.nav.showJournal ? [{ label: "Journal", href: "/journal" }] : []),
    ...(cfg.nav.showArticles ? [{ label: "Articles", href: "/articles" }] : []),
    ...(cfg.nav.showPhotography ? [{ label: "Photography", href: "/photography" }] : []),
    ...(cfg.nav.showVideos ? [{ label: "Videos", href: "/videos" }] : []),
    ...(cfg.nav.showAudio ? [{ label: "Audio", href: "/audio" }] : []),
    ...(cfg.publicFeed ? [{ label: "Fediverse", href: "/fediverse" }] : []),
    ...(cfg.nav.showAbout ? [{ label: "About", href: "/about" }] : []),
    ...(cfg.download.macosEnabled ? [{ label: "Download", href: "/download" }] : []),
  ];
}
