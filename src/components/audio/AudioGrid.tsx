"use client";

import { useState } from "react";
import Link from "next/link";
import CategoryTabs from "@/components/ui/CategoryTabs";

interface AudioItem {
  id: string;
  slug: string;
  title: string | null;
  coverImage: string | null;
  mp3Path: string;
  durationSec: number | null;
  fileSize: number | null;
  publishedAt: string;
  category: string;
}

function formatDuration(sec: number | null): string {
  if (!sec || sec < 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The /audio gallery list with category filter tabs (#284). Client component so
 * it can filter without a round-trip; the hero slider stays in the server page.
 */
export default function AudioGrid({
  audios,
  categories,
  postSlugMap,
}: {
  audios: AudioItem[];
  categories: { key: string; label: string }[];
  postSlugMap: Record<string, string>;
}) {
  const [active, setActive] = useState("all");
  const filtered = active === "all" ? audios : audios.filter((a) => a.category === active);

  return (
    <div>
      <CategoryTabs categories={categories} active={active} onSelect={setActive} />

      {filtered.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-gray-500">No audio in this category yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((audio) => {
            const href = postSlugMap[audio.slug] ? `/post/${postSlugMap[audio.slug]}` : `/audio/${audio.slug}`;
            return (
              <div
                key={audio.id}
                className="bg-surface-800/50 border border-surface-700 rounded-xl p-4 flex items-center gap-4 hover:border-accent-400/30 transition-colors"
              >
                <Link href={href} className="flex-shrink-0">
                  {audio.coverImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={audio.coverImage} alt="" className="w-16 h-16 object-cover rounded" />
                  ) : (
                    <div className="w-16 h-16 bg-surface-700 rounded flex items-center justify-center">
                      <svg className="w-7 h-7 text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
                      </svg>
                    </div>
                  )}
                </Link>
                <div className="flex-1 min-w-0">
                  <Link href={href} className="block">
                    <h3 className="text-sm font-display text-white truncate hover:text-accent-300">
                      {audio.title || audio.slug}
                    </h3>
                  </Link>
                  <div className="flex items-center gap-3 text-[11px] text-gray-500 mt-0.5">
                    <span>{new Date(audio.publishedAt).toLocaleDateString()}</span>
                    {audio.durationSec && <span>{formatDuration(audio.durationSec)}</span>}
                    {audio.fileSize && <span>{(audio.fileSize / (1024 * 1024)).toFixed(1)} MB</span>}
                  </div>
                </div>
                <audio
                  controls
                  preload="none"
                  src={audio.mp3Path}
                  className="w-48 sm:w-64 flex-shrink-0"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
