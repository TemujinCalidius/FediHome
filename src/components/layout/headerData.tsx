import { cookies } from "next/headers";
import { buildNavLinks, type NavLink } from "@/lib/nav";
import { getRuntimeSiteConfig } from "@/lib/site-settings";

/**
 * Shared header data (#250, Phase 4) — the site name, resolved nav links, and
 * admin state every header variant needs. One place so `Navbar`, `HeaderCentered`
 * and `HeaderMinimal` don't each re-derive it. Only the active variant renders,
 * so this runs once per request.
 */
export async function getHeaderData(): Promise<{ name: string; navLinks: NavLink[]; isAdmin: boolean }> {
  const cookieStore = await cookies();
  const adminCookie = cookieStore.get("sl_admin")?.value;
  const { verifyAdminSession } = await import("@/lib/auth");
  const isAdmin = await verifyAdminSession(adminCookie);
  const siteCfg = await getRuntimeSiteConfig();
  return { name: siteCfg.name, navLinks: buildNavLinks(siteCfg), isAdmin };
}

/** The RSS glyph, shared by the header variants. */
export const RssIcon = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M6.18 15.64a2.18 2.18 0 010 4.36 2.18 2.18 0 010-4.36M4 4.44A15.56 15.56 0 0119.56 20h-2.83A12.73 12.73 0 004 7.27V4.44m0 5.66a9.9 9.9 0 019.9 9.9h-2.83A7.07 7.07 0 004 12.93V10.1z" />
  </svg>
);
