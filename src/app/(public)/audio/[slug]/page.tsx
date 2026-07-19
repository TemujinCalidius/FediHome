import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const audio = await prisma.audio.findUnique({ where: { slug } });
  return {
    title: audio?.title || "Audio",
    description: audio?.description || "Audio recording",
  };
}

function formatDuration(sec: number | null): string {
  if (!sec || sec < 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default async function AudioDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const audio = await prisma.audio.findUnique({ where: { slug } });
  if (!audio || !audio.published) notFound();

  const postSlugMatch = slug.match(/^(.+)-audio-\d+$/);
  const linkedPost = postSlugMatch
    ? await prisma.post.findUnique({ where: { slug: postSlugMatch[1] }, select: { slug: true, title: true } })
    : null;

  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <div className="flex items-center gap-5 mb-8">
        {audio.coverImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={audio.coverImage}
            alt=""
            className="w-32 h-32 object-cover rounded-xl flex-shrink-0"
          />
        ) : (
          <div className="w-32 h-32 bg-surface-700 rounded-xl flex items-center justify-center flex-shrink-0">
            <svg className="w-16 h-16 text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
            </svg>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-2xl text-white">{audio.title || "Untitled"}</h1>
          <p className="text-xs text-gray-500 mt-1">
            {new Date(audio.publishedAt).toLocaleDateString()}
            {audio.durationSec ? ` · ${formatDuration(audio.durationSec)}` : ""}
            {audio.fileSize ? ` · ${(audio.fileSize / (1024 * 1024)).toFixed(1)} MB` : ""}
          </p>
        </div>
      </div>

      <audio controls preload="metadata" src={audio.mp3Path} className="w-full mb-6" />

      {audio.description && (
        <p className="text-gray-300 leading-relaxed mb-6 whitespace-pre-wrap">{audio.description}</p>
      )}

      <div className="flex gap-4 text-xs">
        {linkedPost && (
          <Link href={`/post/${linkedPost.slug}`} className="text-gray-400 hover:text-white">
            View original post
          </Link>
        )}
        <Link href="/audio" className="text-gray-400 hover:text-white ml-auto">
          ← All audio
        </Link>
      </div>
    </article>
  );
}
