import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { siteConfig } from "@/../site.config";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const video = await prisma.video.findUnique({ where: { slug } });
  return {
    title: video?.title || "Video",
    description: video?.description || `Video by ${siteConfig.authorName}`,
  };
}

export default async function VideoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const video = await prisma.video.findUnique({ where: { slug } });
  if (!video || !video.published) notFound();

  // If this video came from a post, link back to it
  const postSlugMatch = slug.match(/^(.+)-video-\d+$/);
  const linkedPost = postSlugMatch
    ? await prisma.post.findUnique({ where: { slug: postSlugMatch[1] }, select: { slug: true, title: true } })
    : null;

  return (
    <article className="max-w-4xl mx-auto px-6 py-16">
      <h1 className="font-display text-2xl text-white mb-2">
        {video.title || "Untitled video"}
      </h1>
      <p className="text-xs text-gray-500 mb-6">
        Published {new Date(video.publishedAt).toLocaleDateString()} · from {video.embedHost}
      </p>

      <div className="aspect-video rounded-xl overflow-hidden bg-black mb-6">
        <iframe
          src={video.iframeSrc}
          title={video.title || "Embedded video"}
          allow="fullscreen"
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
          className="w-full h-full border-0"
        />
      </div>

      {video.description && (
        <p className="text-gray-300 leading-relaxed mb-6">{video.description}</p>
      )}

      <div className="flex gap-4 text-xs">
        <a
          href={video.embedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-400 hover:underline"
        >
          Watch on {video.embedHost} →
        </a>
        {linkedPost && (
          <Link href={`/post/${linkedPost.slug}`} className="text-gray-400 hover:text-white">
            View original post
          </Link>
        )}
        <Link href="/videos" className="text-gray-400 hover:text-white ml-auto">
          ← All videos
        </Link>
      </div>
    </article>
  );
}
