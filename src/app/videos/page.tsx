export const dynamic = "force-dynamic";

import Link from "next/link";
import Image from "next/image";
import { prisma } from "@/lib/db";
import HeroSlider, { type HeroSlide } from "@/components/ui/HeroSlider";
import { siteConfig } from "@/../site.config";

export const metadata = {
  title: "Videos",
  description: `Videos by ${siteConfig.authorName} — photo walks, lore, tutorials.`,
};

export default async function VideosPage() {
  const videos = await prisma.video.findMany({
    where: { published: true },
    orderBy: { publishedAt: "desc" },
  });

  // Build a map of video slug → originating post slug for click-through
  const postSlugs = await prisma.post.findMany({
    where: { published: true },
    select: { slug: true },
  });
  const postSlugSet = new Set(postSlugs.map((p) => p.slug));
  const videoToPostMap: Record<string, string> = {};
  for (const v of videos) {
    const m = v.slug.match(/^(.+)-video-\d+$/);
    if (m && postSlugSet.has(m[1])) {
      videoToPostMap[v.slug] = m[1];
    }
  }

  // Hero slider
  const heroVideos = videos.filter((v) => v.hero).sort((a, b) => (a.heroOrder ?? 999) - (b.heroOrder ?? 999)).slice(0, 5);
  const heroSlides: HeroSlide[] = heroVideos.map((v) => ({
    url: v.thumbnailUrl || "/uploads/video-placeholder.png",
    alt: v.title || "Video",
    caption: v.title || undefined,
    href: videoToPostMap[v.slug] ? `/post/${videoToPostMap[v.slug]}` : `/videos/${v.slug}`,
  }));

  if (videos.length === 0) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-16">
        <h1 className="font-display text-3xl font-bold text-white mb-2">Videos</h1>
        <div className="glass-card p-12 text-center">
          <p className="text-gray-500">No videos yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-2">Videos</h1>
      <p className="text-gray-500 mb-8">
        Photo walks, behind-the-scenes, and other longer-form moments.
      </p>

      {heroSlides.length > 0 && (
        <div className="mb-10">
          <HeroSlider slides={heroSlides} />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {videos.map((video) => {
          const href = videoToPostMap[video.slug] ? `/post/${videoToPostMap[video.slug]}` : `/videos/${video.slug}`;
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
    </div>
  );
}
