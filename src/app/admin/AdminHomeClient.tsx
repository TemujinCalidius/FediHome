"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ADMIN_GROUPS, searchAdmin, type AdminDestination } from "@/lib/admin-map";

/**
 * The owner area's home (#368).
 *
 * Three problems from the issue, and which part of this page answers each:
 *
 *  1. "Site settings" and "Instance settings" are indistinguishable — every
 *     destination here is named for what you'd CHANGE, not for which page it
 *     happens to live on, so the two page names stop being the thing you have to
 *     understand first.
 *  2. There is no navigation — this page plus the nav bar above it.
 *  3. Settings only ever grow and there's no way to FIND one — the search box,
 *     which reads the description data in admin-map.ts and can therefore jump
 *     straight to a section anchor on a page it doesn't have to know about.
 *
 * The grouping is by what an owner is trying to DO, not by which route or which
 * of the two settings pages the control happens to sit on. Two entries pointing
 * at different anchors of the same page is the normal case here, not an accident.
 */

function Row({ d }: { d: AdminDestination }) {
  return (
    <Link
      href={d.href}
      className="block rounded-lg border border-surface-800 px-3 py-2.5 hover:border-accent-400/40 hover:bg-accent-400/5 transition-colors"
    >
      <span className="block text-sm text-white">{d.label}</span>
      <span className="block text-xs text-gray-500 mt-0.5">{d.blurb}</span>
    </Link>
  );
}

export default function AdminHomeClient({ stats }: {
  stats: { followers: number; following: number; posts: number; pendingComments: number };
}) {
  const [q, setQ] = useState("");
  const results = useMemo(() => searchAdmin(q), [q]);
  const searching = q.trim().length >= 2;

  return (
    <main className="max-w-4xl mx-auto px-4 py-10">
      <h1 className="text-xl font-semibold text-white">Your FediHome</h1>
      <p className="text-sm text-gray-500 mt-1">
        Everything you can change, in one place. Not sure where something lives? Search for it.
      </p>

      <div className="mt-5">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search settings — try “push”, “blocked”, “backup”…"
          aria-label="Search settings"
          className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-gray-600"
        />
      </div>

      {searching ? (
        <div className="mt-5">
          {results.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nothing matches “{q}”. Try a plainer word — the search knows a few
              names for most things.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {results.map((d) => (
                <Row key={`${d.href}:${d.label}`} d={d} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* A few numbers, so the home page says something about the instance
              rather than being a menu and nothing else. */}
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: "posts", value: stats.posts },
              { label: "followers", value: stats.followers },
              { label: "following", value: stats.following },
              { label: "to moderate", value: stats.pendingComments },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-surface-800 px-3 py-2.5">
                <span className="block text-lg font-semibold text-white">{s.value}</span>
                <span className="block text-xs text-gray-500">{s.label}</span>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-col gap-8">
            {ADMIN_GROUPS.map((g) => (
              <section key={g.title}>
                <h2 className="text-sm font-semibold text-white">{g.title}</h2>
                <p className="text-xs text-gray-600 mt-0.5 mb-3">{g.blurb}</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  {g.items.map((d) => (
                    <Row key={`${d.href}:${d.label}`} d={d} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
