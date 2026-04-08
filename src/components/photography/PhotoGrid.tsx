"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import BuyBadge from "@/components/store/BuyBadge";

function AltBadgeInline({ alt }: { alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="absolute bottom-2 right-2 z-10">
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }}
        className="bg-black/70 text-white text-[10px] font-bold px-1.5 py-0.5 rounded backdrop-blur-sm"
      >
        ALT
      </button>
      {open && (
        <div
          className="absolute bottom-7 right-0 bg-black/85 backdrop-blur-md text-white/90 text-sm p-3 rounded-xl shadow-2xl z-20 leading-relaxed w-64"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {alt}
        </div>
      )}
    </span>
  );
}

interface PhotoItem {
  id: string;
  slug: string;
  title: string | null;
  caption: string | null;
  imagePath: string;
  thumbPath: string | null;
  category: string;
  likeCount: number;
  boostCount: number;
}

interface Category {
  key: string;
  label: string;
}

export default function PhotoGrid({
  photos,
  categories,
  storeItemMap,
  postSlugMap,
}: {
  photos: PhotoItem[];
  categories: Category[];
  storeItemMap?: Record<string, string>;
  postSlugMap?: Record<string, string>;
}) {
  const [activeCategory, setActiveCategory] = useState("all");

  const filtered =
    activeCategory === "all"
      ? photos
      : photos.filter((p) => p.category === activeCategory);

  return (
    <div>
      {/* Category filter tabs */}
      <div className="flex flex-wrap gap-2 mb-8">
        {categories.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveCategory(cat.key)}
            className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-lg border transition-colors ${
              activeCategory === cat.key
                ? "border-accent-400/30 bg-accent-400/10 text-accent-400"
                : "border-surface-700 text-gray-500 hover:text-gray-300 hover:border-surface-600"
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-gray-500">No photos in this category yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((photo) => (
            <Link
              key={photo.id}
              href={postSlugMap?.[photo.slug] ? `/post/${postSlugMap[photo.slug]}` : `/photography/${photo.slug}`}
              className="group relative aspect-square rounded-xl overflow-hidden bg-surface-800 block"
            >
              <Image
                src={(photo.thumbPath || photo.imagePath).split("?")[0]}
                alt={photo.title || photo.caption || ""}
                fill
                className="object-cover group-hover:scale-[1.03] transition-transform duration-300"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              />
              {(() => {
                const raw = (photo.thumbPath || photo.imagePath).split("?")[0];
                const rel = raw.replace(/^https?:\/\/[^/]+/, "");
                const storeId = storeItemMap?.[raw] || storeItemMap?.[rel];
                return storeId ? <BuyBadge storeItemId={storeId} /> : null;
              })()}
              {(photo.title || photo.caption) && (
                <AltBadgeInline alt={photo.title || photo.caption || ""} />
              )}

              {/* Hover overlay */}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors duration-300 flex items-end">
                <div className="p-4 translate-y-4 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
                  {photo.title && (
                    <p className="text-white text-sm font-semibold mb-1">
                      {photo.title}
                    </p>
                  )}
                  <div className="flex gap-2">
                    {photo.likeCount > 0 && (
                      <span className="text-xs text-white/70 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" />
                        </svg>
                        {photo.likeCount}
                      </span>
                    )}
                    {photo.boostCount > 0 && (
                      <span className="text-xs text-white/70 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1z" clipRule="evenodd" />
                        </svg>
                        {photo.boostCount}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
