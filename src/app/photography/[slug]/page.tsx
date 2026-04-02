import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { LightboxGallery } from "@/components/ui/Lightbox";
import FediInteractions from "@/components/fedi/FediInteractions";
import GuestCommentForm from "@/components/fedi/GuestCommentForm";
import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const photo = await prisma.photo.findUnique({ where: { slug } });
  if (!photo) return { title: "Not Found" };
  return {
    title: photo.title || "Photo",
    description: photo.caption || "Photography",
    openGraph: {
      title: photo.title || "Photo",
      images: [photo.imagePath],
    },
  };
}

export default async function PhotoPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const photo = await prisma.photo.findUnique({
    where: { slug },
    include: {
      guestComments: {
        where: { status: "approved" },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!photo || !photo.published) notFound();

  const fediInteractions = photo.apId
    ? await prisma.fediInteraction.findMany({
        where: { targetApId: photo.apId },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const likes = fediInteractions.filter((i) => i.type === "like");
  const boosts = fediInteractions.filter((i) => i.type === "boost");
  const replies = fediInteractions.filter((i) => i.type === "reply");
  const exif = photo.exifData as Record<string, string> | null;

  return (
    <div className="max-w-5xl mx-auto px-6 py-16">
      <Link
        href="/photography"
        className="text-sm text-gray-500 hover:text-accent-400 transition-colors mb-6 inline-block"
      >
        &larr; Back to Gallery
      </Link>

      {/* Large photo display */}
      <LightboxGallery>
        <div className="relative w-full rounded-xl overflow-hidden bg-surface-800 mb-8">
          <Image
            src={photo.imagePath}
            alt={photo.title || photo.caption || ""}
            width={1600}
            height={1200}
            className="w-full h-auto"
            priority
          />
        </div>
      </LightboxGallery>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-8">
        {/* Left: caption + interactions + comments */}
        <div>
          {photo.title && (
            <h1 className="font-display text-2xl font-bold text-white mb-3">
              {photo.title}
            </h1>
          )}

          {photo.caption && (
            <p className="text-gray-400 leading-relaxed mb-4">
              {photo.caption}
            </p>
          )}

          <time className="text-xs text-accent-400 font-mono">
            {photo.publishedAt.toLocaleDateString("en-AU", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </time>

          {photo.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-4">
              {photo.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-surface-800 text-accent-400/70 px-2 py-1 rounded border border-accent-400/10"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          <FediInteractions
            likes={likes}
            boosts={boosts}
            replies={replies}
            likeCount={photo.likeCount}
            boostCount={photo.boostCount}
          />

          {/* Comments */}
          <section className="mt-10">
            <div className="divider mb-6" />
            <h2 className="font-display text-lg font-semibold text-white mb-6">
              Comments
            </h2>

            {(photo.guestComments.length > 0 || replies.length > 0) ? (
              <div className="space-y-4 mb-8">
                {replies.map((reply) => (
                  <div key={reply.id} className="glass-card p-4">
                    <div className="flex items-center gap-2 mb-2">
                      {reply.avatarUrl && (
                        <img src={reply.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                      )}
                      <span className="text-sm font-semibold text-white">
                        {reply.displayName || reply.username}
                      </span>
                      <span className="text-xs text-gray-600">
                        @{reply.username}@{reply.domain}
                      </span>
                    </div>
                    <p className="text-gray-400 text-sm">{reply.content}</p>
                  </div>
                ))}
                {photo.guestComments.map((comment) => (
                  <div key={comment.id} className="glass-card p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-6 h-6 rounded-full bg-surface-700 flex items-center justify-center text-xs text-gray-400">
                        {comment.guestName[0]?.toUpperCase()}
                      </div>
                      <span className="text-sm font-semibold text-white">{comment.guestName}</span>
                      <span className="text-xs text-gray-600">guest</span>
                    </div>
                    <p className="text-gray-400 text-sm">{comment.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-600 text-sm mb-8">No comments yet.</p>
            )}

            <GuestCommentForm photoId={photo.id} />
          </section>
        </div>

        {/* Right: EXIF sidebar */}
        {exif && (
          <div className="glass-card p-5 h-fit">
            <h3 className="text-xs text-accent-400/70 uppercase tracking-wider font-semibold mb-4">
              Camera Details
            </h3>
            <div className="space-y-3 text-sm">
              {exif.camera && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Camera</span>
                  <span className="text-gray-300">{exif.camera}</span>
                </div>
              )}
              {exif.lens && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Lens</span>
                  <span className="text-gray-300">{exif.lens}</span>
                </div>
              )}
              {exif.focalLength && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Focal Length</span>
                  <span className="text-gray-300">{exif.focalLength}</span>
                </div>
              )}
              {exif.aperture && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Aperture</span>
                  <span className="text-gray-300">{exif.aperture}</span>
                </div>
              )}
              {exif.shutter && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Shutter</span>
                  <span className="text-gray-300">{exif.shutter}</span>
                </div>
              )}
              {exif.iso && (
                <div className="flex justify-between">
                  <span className="text-gray-500">ISO</span>
                  <span className="text-gray-300">{exif.iso}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
