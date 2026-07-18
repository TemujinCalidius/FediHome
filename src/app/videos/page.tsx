export const dynamic = "force-dynamic";

import { prisma } from "@/lib/db";
import HeroSlider, { type HeroSlide } from "@/components/ui/HeroSlider";
import VideoGrid from "@/components/videos/VideoGrid";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { unionCategories, buildCategoryTabs } from "@/lib/categories";

export const metadata = {
  title: "Videos",
  description: "A video gallery.",
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

  // Category filter tabs = configured list ∪ categories still in use (#284).
  const cfg = await getRuntimeSiteConfig();
  const categories = buildCategoryTabs(unionCategories(cfg.categories.videos, videos.map((v) => v.category)));

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
        Longer-form moments.
      </p>

      {heroSlides.length > 0 && (
        <div className="mb-10">
          <HeroSlider slides={heroSlides} />
        </div>
      )}

      <VideoGrid
        videos={JSON.parse(JSON.stringify(videos))}
        categories={categories}
        postSlugMap={videoToPostMap}
      />
    </div>
  );
}
