export const dynamic = "force-dynamic";

import Link from "next/link";
import { prisma } from "@/lib/db";
import HeroSlider, { type HeroSlide } from "@/components/ui/HeroSlider";

export const metadata = {
  title: "Audio",
  description: "Audio recordings by Samuel Lison.",
};

function formatDuration(sec: number | null): string {
  if (!sec || sec < 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

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
          <p className="text-gray-500">Recordings, talks, ambient.</p>
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

      <div className="space-y-3">
        {audios.map((audio) => {
          const href = audioToPostMap[audio.slug] ? `/post/${audioToPostMap[audio.slug]}` : `/audio/${audio.slug}`;
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
    </div>
  );
}
