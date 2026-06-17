import { siteConfig } from "@/../site.config";

export interface NavLink {
  label: string;
  href: string;
}

// Visible nav links, derived from siteConfig.nav visibility toggles.
//
// This reads env-driven config at module load, so it must only be imported
// from SERVER components. Client components (e.g. MobileMenu) should receive
// the computed list as a prop instead of importing it directly.
export const navLinks: NavLink[] = [
  { label: "Home", href: "/" },
  ...(siteConfig.nav.showJournal ? [{ label: "Journal", href: "/journal" }] : []),
  ...(siteConfig.nav.showArticles ? [{ label: "Articles", href: "/articles" }] : []),
  ...(siteConfig.nav.showPhotography
    ? [{ label: "Photography", href: "/photography" }]
    : []),
  ...(siteConfig.nav.showVideos ? [{ label: "Videos", href: "/videos" }] : []),
  ...(siteConfig.nav.showAudio ? [{ label: "Audio", href: "/audio" }] : []),
  ...(siteConfig.publicFeed ? [{ label: "Fediverse", href: "/fediverse" }] : []),
  ...(siteConfig.nav.showAbout ? [{ label: "About", href: "/about" }] : []),
];
