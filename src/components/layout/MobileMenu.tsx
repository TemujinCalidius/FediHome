"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navLinks } from "@/lib/nav";

export default function MobileMenu({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="md:hidden">
      {/* Hamburger button */}
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 text-gray-400 hover:text-accent-400 transition-colors"
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

      {/* Dropdown menu */}
      {open && (
        <div
          className="absolute left-0 right-0 top-14 z-50 border-b border-surface-800 shadow-2xl"
          style={{ backgroundColor: "#0a0a0f" }}
        >
          <nav className="flex flex-col px-6 py-4 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`text-base py-2.5 border-b border-surface-800/50 transition-colors ${
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
                className="text-base py-2.5 border-b border-surface-800/50 text-gray-500 hover:text-accent-400 transition-colors"
              >
                Fedi Feed
              </Link>
            )}
            <Link
              href="/feed.xml"
              className="text-base py-2.5 text-gray-500 hover:text-accent-400 transition-colors"
            >
              RSS Feed
            </Link>
          </nav>
        </div>
      )}
    </div>
  );
}
