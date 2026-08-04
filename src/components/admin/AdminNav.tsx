"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The owner area's navigation bar (#368).
 *
 * There wasn't one. A grep for links to `/admin/…` across all of `src/` found
 * them in exactly one file — the `/timeline` header — so an owner who didn't
 * spot that one row of small grey links had no route to Sessions, App activity
 * or Integrations at all, and `/admin` itself returned 404.
 *
 * Rendered from `src/app/admin/layout.tsx`, so every page in the area gets it
 * without each one remembering to. Timeline is included because it is the other
 * half of the owner area and the two were only ever linked one way.
 */

const LINKS = [
  { href: "/admin", label: "Home" },
  { href: "/timeline", label: "Timeline" },
  { href: "/compose", label: "Compose" },
  { href: "/admin/site", label: "Site" },
  { href: "/admin/integrations", label: "Integrations" },
  { href: "/admin/apps", label: "Apps" },
  { href: "/admin/sessions", label: "Sessions" },
  { href: "/admin/audit", label: "Activity" },
  { href: "/admin/settings", label: "Background jobs" },
];

export default function AdminNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Owner area"
      // Scrollable rather than wrapped: nine links wrap to three ragged rows on
      // a phone, and the same overflow-x-auto idiom is what the timeline tabs
      // already use (#147).
      className="border-b border-surface-800 bg-surface-950/60 backdrop-blur sticky top-0 z-30"
    >
      <div className="max-w-4xl mx-auto px-4 flex gap-1 overflow-x-auto">
        {LINKS.map((l) => {
          // Exact match for /admin, prefix for the rest — otherwise Home would
          // be highlighted on every page in the area.
          const active = l.href === "/admin" ? pathname === "/admin" : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`flex-shrink-0 px-3 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                active
                  ? "border-accent-400 text-accent-400"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
