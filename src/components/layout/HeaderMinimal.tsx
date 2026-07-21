import Link from "next/link";
import NotificationBell from "./NotificationBell";
import MobileMenu from "./MobileMenu";
import { getHeaderData } from "./headerData";

/**
 * Header variant: "minimal" (#250, Phase 4). Just the site name and the menu
 * button — the leanest header. No inline desktop nav row or RSS glyph; the
 * shared MobileMenu carries every link at all breakpoints. Admins keep the
 * notification bell. Reading-first, gets out of the way.
 */
export default async function HeaderMinimal() {
  const { name, navLinks, isAdmin } = await getHeaderData();

  return (
    <nav className="border-b border-surface-800 bg-surface-950/90 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="font-display text-lg font-bold text-white hover:text-accent-400 transition-colors">
          {name}
        </Link>
        <div className="flex items-center gap-3">
          {isAdmin && <NotificationBell />}
          {/* Force the menu at every breakpoint by claiming the links are never inline. */}
          <MobileMenu isAdmin={isAdmin} links={navLinks} alwaysCollapsed />
        </div>
      </div>
    </nav>
  );
}
