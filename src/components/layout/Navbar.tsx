import Link from "next/link";
import Image from "next/image";
import { cookies } from "next/headers";
import NotificationBell from "./NotificationBell";
import MobileMenu from "./MobileMenu";
import { siteConfig } from "@/../site.config";

const navLinks = [
  { label: "Home", href: "/" },
  { label: "Journal", href: "/journal" },
  { label: "Articles", href: "/articles" },
  { label: "Photography", href: "/photography" },
  { label: "About", href: "/about" },
];

export default async function Navbar() {
  const cookieStore = await cookies();
  const adminCookie = cookieStore.get("sl_admin")?.value;
  const { hashToken, safeCompare } = await import("@/lib/auth");
  const isAdmin = !!adminCookie && safeCompare(adminCookie, hashToken(process.env.ADMIN_SECRET || ""));

  return (
    <nav className="border-b border-surface-800 bg-surface-950/90 backdrop-blur-md sticky top-0 z-50">
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex-shrink-0 font-display text-lg font-bold text-white hover:text-accent-400 transition-colors">
          {siteConfig.name}
        </Link>

        <div className="hidden md:flex items-center gap-6">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-gray-400 hover:text-accent-400 transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {isAdmin && (
            <Link
              href="/timeline"
              className="text-xs text-gray-500 hover:text-accent-400 transition-colors hidden md:inline"
            >
              Fedi Feed
            </Link>
          )}
          {isAdmin && <NotificationBell />}
          <a
            href="/feed.xml"
            className="text-gray-500 hover:text-accent-400 transition-colors hidden md:block"
            title="RSS Feed"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6.18 15.64a2.18 2.18 0 010 4.36 2.18 2.18 0 010-4.36M4 4.44A15.56 15.56 0 0119.56 20h-2.83A12.73 12.73 0 004 7.27V4.44m0 5.66a9.9 9.9 0 019.9 9.9h-2.83A7.07 7.07 0 004 12.93V10.1z" />
            </svg>
          </a>
          <MobileMenu isAdmin={isAdmin} />
        </div>
      </div>
    </nav>
  );
}
