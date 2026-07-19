import Link from "next/link";
import NotificationBell from "./NotificationBell";
import MobileMenu from "./MobileMenu";
import { getHeaderData, RssIcon } from "./headerData";

/**
 * Header variant: "centered" masthead (#250, Phase 4). The site name sits large
 * and centered above a centered nav row — a publication/editorial feel. Same
 * links + actions as the default bar, different arrangement. Mobile collapses to
 * the shared menu, like the bar.
 */
export default async function HeaderCentered() {
  const { name, navLinks, isAdmin } = await getHeaderData();

  return (
    <nav className="border-b border-surface-800 bg-surface-950/90 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-5xl mx-auto px-6">
        {/* Row 1: centered name; actions pinned right. h-14 on mobile so the
            collapsed menu's dropdown (anchored at top-14) lines up. */}
        <div className="h-14 flex items-center justify-between">
          <div className="w-16 md:w-24" aria-hidden />
          <Link href="/" className="font-display text-xl font-bold text-white hover:text-accent-400 transition-colors text-center">
            {name}
          </Link>
          <div className="flex items-center gap-3 w-16 md:w-24 justify-end">
            {isAdmin && <NotificationBell />}
            <a href="/feed.xml" className="text-gray-500 hover:text-accent-400 transition-colors hidden md:block" title="RSS Feed">
              <RssIcon />
            </a>
            <MobileMenu isAdmin={isAdmin} links={navLinks} />
          </div>
        </div>

        {/* Row 2: centered nav links (desktop only) */}
        <div className="hidden md:flex items-center justify-center gap-6 pb-2 -mt-1">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} className="text-sm text-gray-400 hover:text-accent-400 transition-colors">
              {link.label}
            </Link>
          ))}
          {isAdmin && (
            <Link href="/timeline" className="text-xs text-gray-500 hover:text-accent-400 transition-colors">
              Fedi Feed
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
