export const dynamic = "force-dynamic";

import { prisma } from "@/lib/db";
import HeroSlider, { type HeroSlide } from "@/components/ui/HeroSlider";
import AudioGrid from "@/components/audio/AudioGrid";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { unionCategories, buildCategoryTabs } from "@/lib/categories";

export const metadata = {
  title: "Audio",
  description: "An audio gallery.",
};

export default async function AudioPage() {
  const audios = await prisma.audio.findMany({
    where: { published: true },
    orderBy: { publishedAt: "desc" },
  });

  // Map audio slugs back to originating post slugs
  const postSlugs = await prisma.post.findMany({
    where: { published: true },
    select: { slug: true },
  });
  const postSlugSet = new Set(postSlugs.map((p) => p.slug));
  const audioToPostMap: Record<string, string> = {};
  for (const a of audios) {
    const m = a.slug.match(/^(.+)-audio-\d+$/);
    if (m && postSlugSet.has(m[1])) audioToPostMap[a.slug] = m[1];
  }

  // Hero slider for hero audio
  const heroAudio = audios
    .filter((a) => a.hero && a.coverImage)
    .sort((a, b) => (a.heroOrder ?? 999) - (b.heroOrder ?? 999))
    .slice(0, 5);
  const heroSlides: HeroSlide[] = heroAudio.map((a) => ({
    url: a.coverImage!,
    alt: a.title || "Featured audio",
    caption: a.title || undefined,
    href: audioToPostMap[a.slug] ? `/post/${audioToPostMap[a.slug]}` : `/audio/${a.slug}`,
  }));

  // Category filter tabs = configured list ∪ categories still in use (#284).
  const cfg = await getRuntimeSiteConfig();
  const categories = buildCategoryTabs(unionCategories(cfg.categories.audio, audios.map((a) => a.category)));

  if (audios.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="font-display text-3xl font-bold text-white mb-2">Audio</h1>
        <div className="glass-card p-12 text-center">
          <p className="text-gray-500">No audio yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-16">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display text-3xl font-bold text-white mb-2">Audio</h1>
          <p className="text-gray-500">Recordings.</p>
        </div>
        <a
          href="/audio/feed.xml"
          className="text-xs text-accent-400 hover:text-accent-300 flex items-center gap-1.5"
          title="Subscribe with a podcast app"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3.429 5.1A1.5 1.5 0 016.5 5.1c1.7 8.3 5.2 11.8 13.5 13.5a1.5 1.5 0 010 2.93 1.5 1.5 0 01-1.07 0C8.74 19.62 4.38 15.26 2.43 5.97a1.5 1.5 0 011-1.87zM3 11a8 8 0 018 8h-2a6 6 0 00-6-6v-2zm0-7a15 15 0 0115 15h-2a13 13 0 00-13-13V4z" />
          </svg>
          RSS
        </a>
      </div>

      {heroSlides.length > 0 && (
        <div className="mb-10">
          <HeroSlider slides={heroSlides} />
        </div>
      )}

      <AudioGrid
        audios={JSON.parse(JSON.stringify(audios))}
        categories={categories}
        postSlugMap={audioToPostMap}
      />
    </div>
  );
}
