"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navLinks = [
  { label: "Home", href: "/" },
  { label: "Journal", href: "/journal" },
  { label: "Articles", href: "/articles" },
  { label: "Photography", href: "/photography" },
  { label: "Store", href: "/store" },
  { label: "About", href: "/about" },
];

export default function MobileMenu({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close menu on navigation
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Prevent scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      {/* Hamburger button — visible only on mobile */}
      <button
        onClick={() => setOpen(!open)}
        className="md:hidden p-1.5 text-gray-400 hover:text-accent-400 transition-colors"
        aria-label="Menu"
      >
        {open ? (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>

      {/* Mobile menu overlay */}
      {open && (
        <div className="fixed inset-0 top-14 z-40 bg-surface-950/98 backdrop-blur-md md:hidden">
          <nav className="flex flex-col px-6 py-6 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`text-lg py-3 border-b border-surface-800 transition-colors ${
                  pathname === link.href
                    ? "text-accent-400"
                    : "text-gray-300 hover:text-accent-400"
                }`}
              >
                {link.label}
              </Link>
            ))}
            {isAdmin && (
              <Link
                href="/timeline"
                className="text-lg py-3 border-b border-surface-800 text-gray-500 hover:text-accent-400 transition-colors"
              >
                Fedi Feed
              </Link>
            )}
            <Link
              href="/feed.xml"
              className="text-lg py-3 text-gray-500 hover:text-accent-400 transition-colors"
            >
              RSS Feed
            </Link>
          </nav>
        </div>
      )}
    </>
  );
}
