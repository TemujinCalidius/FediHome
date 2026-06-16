export const dynamic = "force-dynamic";

import Link from "next/link";
import Image from "next/image";
import { prisma } from "@/lib/db";
import PostCard from "@/components/blog/PostCard";
import Pagination from "@/components/ui/Pagination";
import { siteConfig } from "@/../site.config";

const POSTS_PER_PAGE = 10;

// Feature highlights shown on the landing page (LANDING_MODE=true).
const LANDING_FEATURES = [
  {
    title: "Own your content",
    body: "Your posts, photos, videos and audio live on your own domain — not on a platform that can change the rules.",
  },
  {
    title: "Federated by default",
    body: "FediHome speaks ActivityPub, so anyone on Mastodon and the wider Fediverse can follow, reply and boost.",
  },
  {
    title: "A real feed",
    body: "Follow people across the Fediverse and read them in a timeline that lives on your own site.",
  },
  {
    title: "Blog + media built in",
    body: "Articles, journal notes, a photography gallery, and video and audio sections — all first-class.",
  },
  {
    title: "Self-hosted & open source",
    body: "MIT-licensed and made to run on your own box. Updates are a single command and never touch your data.",
  },
  {
    title: "IndieWeb friendly",
    body: "Micropub publishing, RSS, WebFinger and PWA support work out of the box.",
  },
];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10));

  // Hide author follow-ups from the homepage feed — they appear inline on the
  // original post's page instead.
  const totalPosts = await prisma.post.count({
    where: { published: true, inReplyToPostId: null },
  });
  const totalPages = Math.ceil(totalPosts / POSTS_PER_PAGE);

  const recentPosts = await prisma.post.findMany({
    where: { published: true, inReplyToPostId: null },
    orderBy: { publishedAt: "desc" },
    take: POSTS_PER_PAGE,
    skip: (page - 1) * POSTS_PER_PAGE,
  });

  return (
    <div>
      {/* Hero banner — only on page 1 */}
      {page === 1 && (
        <div className="relative w-full h-48 md:h-64 overflow-hidden">
          <Image
            src={siteConfig.bannerPath}
            alt=""
            fill
            className="object-cover"
            priority
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-surface-950" />
        </div>
      )}

      <div className="max-w-3xl mx-auto px-6 py-12 md:py-16">
      {/* Intro — only on page 1.
          LANDING_MODE swaps the personal intro for a project-style landing
          (hero + feature highlights + CTAs). Off by default. */}
      {page === 1 && siteConfig.landingMode && (
        <section className="mb-16">
          <h1 className="font-display text-4xl md:text-5xl font-bold text-white leading-tight">
            {siteConfig.landingHeadline}
          </h1>
          <p className="text-lg text-gray-400 leading-relaxed max-w-2xl mt-4">
            {siteConfig.landingSubhead}
          </p>
          <div className="flex flex-wrap gap-3 mt-6">
            <a
              href={siteConfig.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-outlined text-xs"
            >
              View on GitHub
            </a>
            <Link href="/about" className="btn-outlined text-xs">
              About FediHome
            </Link>
          </div>
          <p className="text-gray-500 mt-4 text-sm">
            Follow{" "}
            <span className="text-accent-400">{siteConfig.fediAddress}</span> on
            the Fediverse.
          </p>

          <div className="grid gap-4 sm:grid-cols-2 mt-12">
            {LANDING_FEATURES.map((feature) => (
              <div key={feature.title} className="glass-card p-5">
                <h3 className="font-display text-base font-semibold text-white">
                  {feature.title}
                </h3>
                <p className="text-sm text-gray-400 leading-relaxed mt-2">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Personal intro — the default homepage when LANDING_MODE is off */}
      {page === 1 && !siteConfig.landingMode && (
        <section className="mb-16">
          <div className="flex items-center gap-4 mb-4">
            <Image
              src={siteConfig.avatarPath}
              alt={siteConfig.authorName}
              width={64}
              height={64}
              className="rounded-full ring-2 ring-accent-400/20"
            />
            <h1 className="font-display text-3xl md:text-4xl font-bold text-white">
              {siteConfig.authorName}
            </h1>
          </div>
          {siteConfig.authorTagline && (
            <p className="text-lg text-gray-400 leading-relaxed max-w-2xl">
              {siteConfig.authorTagline}
            </p>
          )}
          <p className="text-gray-500 mt-4 leading-relaxed">
            Welcome to my FediHome &mdash; a personal space on the Fediverse.
          </p>
          <div className="flex flex-wrap gap-3 mt-6">
            <Link href="/about" className="btn-outlined text-xs">
              About Me
            </Link>
            <Link href="/photography" className="btn-outlined text-xs">
              Photography
            </Link>
            <Link href="/videos" className="btn-outlined text-xs">
              Videos
            </Link>
            <Link href="/audio" className="btn-outlined text-xs">
              Audio
            </Link>
          </div>
        </section>
      )}

      {/* Recent Posts */}
      <section>
        <div className="flex items-center justify-between mb-8">
          <h2 className="font-display text-xl font-semibold text-white">
            {page === 1 ? "Recent Posts" : "Posts"}
          </h2>
          <a
            href="/feed.xml"
            className="text-xs text-gray-500 hover:text-accent-400 transition-colors flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6.18 15.64a2.18 2.18 0 010 4.36 2.18 2.18 0 010-4.36M4 4.44A15.56 15.56 0 0119.56 20h-2.83A12.73 12.73 0 004 7.27V4.44m0 5.66a9.9 9.9 0 019.9 9.9h-2.83A7.07 7.07 0 004 12.93V10.1z" />
            </svg>
            RSS
          </a>
        </div>

        {recentPosts.length === 0 ? (
          <div className="glass-card p-8 text-center">
            <p className="text-gray-500">
              No posts yet. Publish your first post via Micropub to get started.
            </p>
          </div>
        ) : (
          <div className="space-y-12">
            {recentPosts.map((post) => (
              <PostCard key={post.id} {...post} />
            ))}
          </div>
        )}

        <Pagination
          currentPage={page}
          totalPages={totalPages}
          basePath="/"
        />
      </section>
      </div>
    </div>
  );
}
