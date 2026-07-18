"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import CategoryTabs from "@/components/ui/CategoryTabs";

interface VideoItem {
  id: string;
  slug: string;
  title: string | null;
  thumbnailUrl: string | null;
  duration: number | null;
  category: string;
}

/**
 * The /videos gallery grid with category filter tabs (#284). Client component so
 * it can filter by category without a round-trip; the hero slider stays in the
 * server page. Mirrors the photo gallery's filter pattern.
 */
export default function VideoGrid({
  videos,
  categories,
  postSlugMap,
}: {
  videos: VideoItem[];
  categories: { key: string; label: string }[];
  postSlugMap: Record<string, string>;
}) {
  const [active, setActive] = useState("all");
  const filtered = active === "all" ? videos : videos.filter((v) => v.category === active);

  return (
    <div>
      <CategoryTabs categories={categories} active={active} onSelect={setActive} />

      {filtered.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-gray-500">No videos in this category yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((video) => {
            const href = postSlugMap[video.slug] ? `/post/${postSlugMap[video.slug]}` : `/videos/${video.slug}`;
            return (
              <Link
                key={video.id}
                href={href}
                className="group relative aspect-video rounded-xl overflow-hidden bg-surface-800 block"
              >
                {video.thumbnailUrl ? (
                  <Image
                    src={video.thumbnailUrl}
                    alt={video.title || ""}
                    fill
                    className="object-cover group-hover:scale-[1.02] transition-transform duration-300"
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                  />
                ) : (
                  <div className="w-full h-full bg-surface-700 flex items-center justify-center">
                    <svg className="w-12 h-12 text-accent-400/50" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                )}
                {/* Play icon overlay */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                  <div className="w-14 h-14 rounded-full bg-white/90 flex items-center justify-center">
                    <svg className="w-6 h-6 text-black ml-1" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </div>
                {video.duration && (
                  <span className="absolute bottom-2 right-2 bg-black/70 text-white text-[10px] font-mono px-1.5 py-0.5 rounded">
                    {Math.floor(video.duration / 60)}:{String(video.duration % 60).padStart(2, "0")}
                  </span>
                )}
                {video.title && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 pt-8">
                    <p className="text-white text-sm font-display line-clamp-2">{video.title}</p>
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
