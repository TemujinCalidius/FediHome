export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { verifyAdminCookieValue } from "@/lib/auth";
import { prisma } from "@/lib/db";
import ComposeClient, { type InitialValues } from "./ComposeClient";
import TimelineLogin from "../timeline/TimelineLogin";

export const metadata = {
  title: "Compose",
  description: "Write a new post.",
};

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const cookieStore = await cookies();
  const isAdmin = verifyAdminCookieValue(cookieStore.get("sl_admin")?.value);

  if (!isAdmin) {
    return <TimelineLogin />;
  }

  const params = await searchParams;
  let editingPostId: string | null = null;
  let initialValues: InitialValues | null = null;

  if (params.edit) {
    const post = await prisma.post.findUnique({
      where: { id: params.edit },
    });
    if (!post) {
      notFound();
    }
    editingPostId = post.id;
    initialValues = {
      title: post.title ?? "",
      content: post.content,
      description: post.excerpt ?? "",
      photos: (post.photos || []).map((url, i) => ({
        url,
        alt: post.photoCaptions?.[i] ?? "",
      })),
      videos: (post.videos || []).map((url, i) => ({
        url,
        title: post.videoTitles?.[i] ?? "",
        thumbnailUrl: post.videoThumbnails?.[i] || null,
      })),
      audios: (post.audioPaths || []).map((url, i) => ({
        url,
        title: post.audioTitles?.[i] ?? "",
        coverImage: post.audioCovers?.[i] || null,
      })),
    };
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="flex items-center justify-between mb-8">
        <h1 className="font-display text-3xl font-bold text-white">
          {editingPostId ? "Edit post" : "Compose"}
        </h1>
        <a
          href="/timeline"
          className="text-xs text-gray-500 hover:text-accent-400 transition-colors"
        >
          Back to Timeline
        </a>
      </div>
      <ComposeClient editingPostId={editingPostId} initialValues={initialValues} />
    </div>
  );
}
