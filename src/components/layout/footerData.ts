import { getSiteStats } from "@/lib/tinylytics";
import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "@/lib/site-profile";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { buildNavLinks, type NavLink } from "@/lib/nav";

/**
 * Shared footer data (#250) — everything the footer variants need, in one place
 * so `Footer` (the `row` default), `FooterMinimal` and `FooterColumns` don't each
 * re-derive it. Only the active variant renders, so this runs once per request,
 * and all three sources are already cached (site stats 5 min; runtime config +
 * profile 60 s).
 */
export interface FooterData {
  stats: { totalHits: number; totalKudos: number } | null;
  authorName: string;
  siteName: string;
  footer: Awaited<ReturnType<typeof getRuntimeSiteConfig>>["footer"];
  navLinks: NavLink[];
  fediAddress: string;
  contactEmail: string;
  year: number;
}

export async function getFooterData(): Promise<FooterData> {
  const [stats, profile, site] = await Promise.all([
    getSiteStats(),
    getRuntimeProfile(),
    getRuntimeSiteConfig(),
  ]);
  return {
    stats,
    authorName: profile.authorName,
    siteName: site.name,
    footer: site.footer,
    navLinks: buildNavLinks(site),
    fediAddress: siteConfig.fediAddress,
    // Prefer the web-editable contact email, falling back to the env default
    // (identical unless the owner set an override in Site settings).
    contactEmail: site.contact.email || siteConfig.contactEmail,
    year: new Date().getFullYear(),
  };
}
