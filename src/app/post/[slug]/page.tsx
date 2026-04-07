import { notFound } from "next/navigation";
import Image from "next/image";
import { prisma } from "@/lib/db";
import { marked } from "marked";
import { cookies } from "next/headers";
import { hashToken, safeCompare } from "@/lib/auth";
import { LightboxGallery } from "@/components/ui/Lightbox";
import GuestCommentForm from "@/components/fedi/GuestCommentForm";
import FediInteractions from "@/components/fedi/FediInteractions";
import ReplyToComment from "@/components/fedi/ReplyToComment";
import type { Metadata } from "next";

function linkHashtags(html: string): string {
  // Link #hashtags but skip ones already inside <a> tags
  return html.replace(
    /(?<!["\/\w])#([a-zA-Z0-9_]+)/g,
    '<a href="https://mastodon.social/tags/$1" class="hashtag" rel="tag">#$1</a>'
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await prisma.post.findUnique({ where: { slug } });
  if (!post) return { title: "Not Found" };
  return {
    title: post.title || "Post",
    description: post.excerpt || post.content.slice(0, 160),
    openGraph: {
      title: post.title || "Post",
      description: post.excerpt || post.content.slice(0, 160),
      type: "article",
      publishedTime: post.publishedAt.toISOString(),
      images: post.coverImage ? [post.coverImage] : [],
    },
  };
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Check admin status for reply buttons
  const cookieStore = await cookies();
  const adminCookie = cookieStore.get("sl_admin")?.value;
  const isAdmin = !!adminCookie && safeCompare(adminCookie, hashToken(process.env.ADMIN_SECRET || ""));

  const post = await prisma.post.findUnique({
    where: { slug },
    include: {
      guestComments: {
        where: { status: "approved" },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!post || !post.published) notFound();

  // Fetch Fedi interactions for this post
  const fediInteractions = post.apId
    ? await prisma.fediInteraction.findMany({
        where: { targetApId: post.apId },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const likes = fediInteractions.filter((i) => i.type === "like");
  const boosts = fediInteractions.filter((i) => i.type === "boost");
  const incomingReplies = fediInteractions.filter((i) => i.type === "reply");

  // Fetch our own outgoing replies to this post
  const outgoingReplies = post.apId
    ? await prisma.fediPost.findMany({
        where: { inReplyTo: post.apId, isOutgoing: true },
        orderBy: { publishedAt: "asc" },
      })
    : [];

  // Merge into a single sorted thread
  const replies = [
    ...incomingReplies.map((r) => ({
      id: r.id,
      isOwn: false,
      avatarUrl: r.avatarUrl,
      displayName: r.displayName,
      username: r.username,
      domain: r.domain,
      content: r.content || "",
      actorUri: r.actorUri,
      createdAt: r.createdAt,
    })),
    ...outgoingReplies.map((r) => ({
      id: r.id,
      isOwn: true,
      avatarUrl: r.avatarUrl,
      displayName: r.displayName,
      username: r.username,
      domain: r.domain,
      content: r.contentHtml || r.content,
      actorUri: r.actorUri,
      createdAt: r.publishedAt,
    })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Fetch fresh Bluesky replies (poll on every page load if post has a blueskyUri)
  if (post.blueskyUri) {
    try {
      const { pollBlueskyReplies } = await import("@/lib/bluesky-poll");
      await pollBlueskyReplies(post.id, post.blueskyUri);
    } catch (err) {
      console.error("Bluesky poll failed:", err);
    }
  }

  const blueskyReplies = await prisma.blueskyReply.findMany({
    where: { postId: post.id },
    orderBy: { createdAt: "asc" },
  });

  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      {/* Header */}
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <time className="text-sm text-accent-400 font-mono">
            {post.publishedAt.toLocaleDateString("en-AU", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </time>
          <span className="text-xs text-gray-600 uppercase tracking-wider">
            {post.category}
          </span>
        </div>

        {post.title && (
          <h1 className="font-display text-3xl md:text-4xl font-bold text-white mb-4">
            {post.title}
          </h1>
        )}

        {post.tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {post.tags.map((tag) => (
              <span
                key={tag}
                className="text-xs bg-surface-800 text-accent-400/70 px-2 py-1 rounded border border-accent-400/10"
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
      </header>

      {/* Cover image + Photo gallery (lightbox enabled) */}
      <LightboxGallery>
        {post.coverImage && (
          <div className="relative w-full aspect-[16/9] rounded-xl overflow-hidden mb-8 bg-surface-800">
            <Image
              src={post.coverImage}
              alt={post.title || ""}
              fill
              className="object-cover"
              priority
            />
          </div>
        )}

        {post.photos.length > 0 && (
          <div className="space-y-4 mb-8">
            {post.photos.map((photo, i) => (
              <div
                key={i}
                className="relative w-full rounded-xl overflow-hidden bg-surface-800"
              >
                <Image
                  src={photo}
                  alt={post.photoCaptions?.[i] || `Photo ${i + 1}`}
                  width={1200}
                  height={800}
                  className="w-full h-auto"
                />
              </div>
            ))}
          </div>
        )}
      </LightboxGallery>

      {/* Content */}
      <div
        className="prose-sl text-gray-300 leading-relaxed [&_a]:text-accent-400 [&_a:hover]:text-accent-300 [&_a]:underline [&_p]:mb-4 [&_h2]:font-display [&_h2]:text-white [&_h2]:text-xl [&_h2]:mt-8 [&_h2]:mb-3 [&_h3]:font-display [&_h3]:text-white [&_h3]:text-lg [&_h3]:mt-6 [&_h3]:mb-2 [&_ul]:list-disc [&_ul]:ml-5 [&_ul]:mb-4 [&_ol]:list-decimal [&_ol]:ml-5 [&_ol]:mb-4 [&_li]:mb-1 [&_blockquote]:border-l-4 [&_blockquote]:border-accent-400/30 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-gray-400 [&_code]:bg-surface-800 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-accent-300 [&_code]:text-sm [&_strong]:text-white"
        dangerouslySetInnerHTML={{ __html: linkHashtags(post.contentHtml || (marked.parse(post.content) as string)) }}
      />

      {/* Fedi interactions */}
      <FediInteractions
        likes={likes}
        boosts={boosts}
        replies={replies}
        likeCount={post.likeCount}
        boostCount={post.boostCount}
        bskyLikeCount={post.bskyLikeCount}
        bskyRepostCount={post.bskyRepostCount}
        blueskyReplyCount={blueskyReplies.length}
      />

      {/* Comments section */}
      <section className="mt-12">
        <div className="divider mb-8" />
        <h2 className="font-display text-lg font-semibold text-white mb-6">
          Comments
        </h2>

        {/* Approved guest comments + fedi replies + bluesky replies */}
        {(post.guestComments.length > 0 || replies.length > 0 || blueskyReplies.length > 0) ? (
          <div className="space-y-4 mb-8">
            {/* Fedi replies (incoming + own) */}
            {replies.map((reply) => (
              <div key={reply.id} className={`glass-card p-4 ${reply.isOwn ? "border-l-2 border-accent-400/40" : ""}`}>
                <div className="flex items-center gap-2 mb-2">
                  {reply.avatarUrl ? (
                    <img src={reply.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-surface-700" />
                  )}
                  <span className="text-sm font-semibold text-white">
                    {reply.displayName || reply.username}
                  </span>
                  <span className="text-xs text-gray-600">
                    @{reply.username}@{reply.domain}
                  </span>
                  {reply.isOwn ? (
                    <span className="text-xs text-accent-400">Author</span>
                  ) : (
                    <span className="text-xs text-gray-700">via Fediverse</span>
                  )}
                </div>
                <div className="text-gray-400 text-sm [&_a]:text-accent-400 [&_a]:hover:underline" dangerouslySetInnerHTML={{ __html: reply.content || "" }} />
                {isAdmin && !reply.isOwn && post.apId && (
                  <div className="mt-2">
                    <ReplyToComment
                      postApId={post.apId}
                      actorUri={reply.actorUri}
                      username={reply.username}
                      domain={reply.domain}
                    />
                  </div>
                )}
              </div>
            ))}

            {/* Bluesky replies */}
            {blueskyReplies.map((reply) => (
              <div key={reply.id} className="glass-card p-4">
                <div className="flex items-center gap-2 mb-2">
                  {reply.avatarUrl && (
                    <img
                      src={reply.avatarUrl}
                      alt=""
                      className="w-6 h-6 rounded-full"
                    />
                  )}
                  <span className="text-sm font-semibold text-white">
                    {reply.displayName || reply.authorHandle}
                  </span>
                  <span className="text-xs text-gray-600">
                    @{reply.authorHandle}
                  </span>
                  <span className="text-xs text-blue-400">via Bluesky</span>
                </div>
                <p className="text-gray-400 text-sm">{reply.content}</p>
              </div>
            ))}

            {/* Guest comments */}
            {post.guestComments.map((comment) => (
              <div key={comment.id} className="glass-card p-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full bg-surface-700 flex items-center justify-center text-xs text-gray-400">
                    {comment.guestName[0]?.toUpperCase()}
                  </div>
                  <span className="text-sm font-semibold text-white">
                    {comment.guestName}
                  </span>
                  <span className="text-xs text-gray-600">guest</span>
                </div>
                <p className="text-gray-400 text-sm">{comment.content}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-600 text-sm mb-8">
            No comments yet. Be the first to share your thoughts.
          </p>
        )}

        {/* Guest comment form */}
        <GuestCommentForm postId={post.id} />
      </section>
    </article>
  );
}
