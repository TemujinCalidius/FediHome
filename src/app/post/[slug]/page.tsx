import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { marked } from "marked";
import { cookies } from "next/headers";
import { verifyAdminSession } from "@/lib/auth";
import { postOgImage, postOgDescription } from "@/lib/og";
import { sanitizeHtml } from "@/lib/sanitize";
import { LightboxGallery } from "@/components/ui/Lightbox";
import { iframeSrcFor } from "@/lib/peertube";
import { getPathHits, getKudosForPath } from "@/lib/tinylytics";
import GuestCommentForm from "@/components/fedi/GuestCommentForm";
import FediInteractions from "@/components/fedi/FediInteractions";
import ReplyToComment from "@/components/fedi/ReplyToComment";
import EditReplyForm from "@/components/fedi/EditReplyForm";
import AuthorFollowUpForm from "@/components/fedi/AuthorFollowUpForm";
import KudosButton from "@/components/ui/KudosButton";
import { siteConfig } from "@/../site.config";
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
  const title = post.title || "Post";
  const description = postOgDescription(post);
  const image = postOgImage(post);
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      publishedTime: post.publishedAt.toISOString(),
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
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
  const isAdmin = await verifyAdminSession(adminCookie);

  const post = await prisma.post.findUnique({
    where: { slug },
    include: {
      guestComments: {
        where: { status: "approved" },
        orderBy: { createdAt: "asc" },
      },
      followUps: {
        where: { published: true },
        orderBy: { publishedAt: "asc" },
      },
      inReplyTo: {
        select: { slug: true, title: true, content: true },
      },
    },
  });

  if (!post || !post.published) notFound();

  // Fetch analytics
  const postPath = `/post/${slug}`;
  const [viewCount, kudosCount] = await Promise.all([
    getPathHits(postPath),
    getKudosForPath(postPath),
  ]);

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

  // Bluesky per-actor likers/reposters — recorded by syncBlueskyNotifications
  // (#134), so the post page can show their avatars, not just the aggregate count.
  const bskyInteractions = post.blueskyUri
    ? await prisma.blueskyInteraction.findMany({
        where: { subjectUri: post.blueskyUri, type: { in: ["like", "repost"] } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const likeAvatars = [
    ...likes.map((l) => ({ id: l.id, label: `@${l.username}@${l.domain}`, avatarUrl: l.avatarUrl, source: "fedi" as const })),
    ...bskyInteractions
      .filter((i) => i.type === "like")
      .map((b) => ({ id: b.id, label: `@${b.authorHandle}`, avatarUrl: b.avatarUrl, source: "bluesky" as const })),
  ];
  const repostAvatars = [
    ...boosts.map((b) => ({ id: b.id, label: `@${b.username}@${b.domain}`, avatarUrl: b.avatarUrl, source: "fedi" as const })),
    ...bskyInteractions
      .filter((i) => i.type === "repost")
      .map((b) => ({ id: b.id, label: `@${b.authorHandle}`, avatarUrl: b.avatarUrl, source: "bluesky" as const })),
  ];

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
      rawContent: null as string | null,
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
      rawContent: r.content,
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
      const cause = err instanceof Error && err.cause ? ` cause=${String(err.cause)}` : "";
      console.error(
        `Bluesky poll failed for post ${post.id} (${post.blueskyUri}):${cause}`,
        err,
      );
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
        {post.inReplyTo && (
          <div className="text-sm text-gray-500 mb-3">
            <Link
              href={`/post/${post.inReplyTo.slug}`}
              className="text-accent-400 hover:text-accent-300 transition-colors"
            >
              ↩ in reply to{" "}
              <span className="underline">
                {post.inReplyTo.title || post.inReplyTo.content.slice(0, 60).trim() + (post.inReplyTo.content.length > 60 ? "…" : "")}
              </span>
            </Link>
          </div>
        )}
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
          {isAdmin && (
            <Link
              href={`/compose?edit=${post.id}`}
              className="ml-auto text-xs text-gray-500 hover:text-accent-400 transition-colors"
            >
              Edit post
            </Link>
          )}
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

      {/* Video embeds */}
      {post.videos && post.videos.length > 0 && (
        <div className="space-y-4 mb-8">
          {post.videos.map((videoUrl, i) => {
            const src = iframeSrcFor(videoUrl);
            if (!src) return null;
            return (
              <figure key={videoUrl} className="space-y-2">
                <div className="aspect-video rounded-xl overflow-hidden bg-black">
                  <iframe
                    src={src}
                    title={post.videoTitles?.[i] || "Embedded video"}
                    allow="fullscreen"
                    sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                    className="w-full h-full border-0"
                  />
                </div>
                {post.videoTitles?.[i] && (
                  <figcaption className="text-xs text-gray-500">{post.videoTitles[i]}</figcaption>
                )}
              </figure>
            );
          })}
        </div>
      )}

      {/* Audio players */}
      {post.audioPaths && post.audioPaths.length > 0 && (
        <div className="space-y-4 mb-8">
          {post.audioPaths.map((src, i) => (
            <figure key={src} className="bg-surface-800/50 border border-surface-700 rounded-xl p-4 flex items-center gap-4">
              {post.audioCovers?.[i] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={post.audioCovers[i]}
                  alt=""
                  className="w-20 h-20 object-cover rounded flex-shrink-0"
                />
              ) : (
                <div className="w-20 h-20 bg-surface-700 rounded flex items-center justify-center flex-shrink-0">
                  <svg className="w-10 h-10 text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
                  </svg>
                </div>
              )}
              <div className="flex-1 min-w-0">
                {post.audioTitles?.[i] && (
                  <figcaption className="text-sm text-white mb-2 truncate">{post.audioTitles[i]}</figcaption>
                )}
                <audio controls preload="metadata" src={src} className="w-full" />
              </div>
            </figure>
          ))}
        </div>
      )}

      {/* Content */}
      <div
        className="prose-sl text-gray-300 leading-relaxed [&_a]:text-accent-400 [&_a:hover]:text-accent-300 [&_a]:underline [&_p]:mb-4 [&_h2]:font-display [&_h2]:text-white [&_h2]:text-xl [&_h2]:mt-8 [&_h2]:mb-3 [&_h3]:font-display [&_h3]:text-white [&_h3]:text-lg [&_h3]:mt-6 [&_h3]:mb-2 [&_ul]:list-disc [&_ul]:ml-5 [&_ul]:mb-4 [&_ol]:list-decimal [&_ol]:ml-5 [&_ol]:mb-4 [&_li]:mb-1 [&_blockquote]:border-l-4 [&_blockquote]:border-accent-400/30 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-gray-400 [&_code]:bg-surface-800 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-accent-300 [&_code]:text-sm [&_strong]:text-white"
        dangerouslySetInnerHTML={{
          __html: linkHashtags(
            post.contentHtml ?? sanitizeHtml(marked.parse(post.content) as string)
          ),
        }}
      />

      {/* Analytics + Kudos */}
      <div className="flex items-center gap-4 mt-8 mb-4">
        <KudosButton path={postPath} initialCount={kudosCount} />
        <span className="text-xs text-gray-600 font-mono">
          {viewCount.toLocaleString()} views
        </span>
      </div>

      {/* Fedi interactions */}
      <FediInteractions
        likeAvatars={likeAvatars}
        repostAvatars={repostAvatars}
        likeCount={post.likeCount}
        boostCount={post.boostCount}
        bskyLikeCount={post.bskyLikeCount}
        bskyRepostCount={post.bskyRepostCount}
        replyCount={replies.length + blueskyReplies.length}
      />

      {/* Comments section */}
      <section className="mt-12">
        <div className="divider mb-8" />
        <h2 className="font-display text-lg font-semibold text-white mb-6">
          Comments
        </h2>

        {/* Approved guest comments + fedi replies + bluesky replies + author follow-ups */}
        {(post.guestComments.length > 0 || replies.length > 0 || blueskyReplies.length > 0 || post.followUps.length > 0) ? (
          <div className="space-y-4 mb-8">
            {/* Author follow-ups (self-replies cross-posted to threads) */}
            {post.followUps.map((followUp) => (
              <div key={followUp.id} className="glass-card p-4 border-l-2 border-accent-400/40">
                <div className="flex items-center gap-2 mb-2">
                  <Image
                    src={siteConfig.avatarPath}
                    alt=""
                    width={24}
                    height={24}
                    className="rounded-full"
                  />
                  <span className="text-sm font-semibold text-white">{siteConfig.authorName}</span>
                  <span className="text-xs text-accent-400">Author follow-up</span>
                  <time className="text-xs text-gray-600 ml-auto">
                    {followUp.publishedAt.toLocaleDateString("en-AU", {
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </div>
                <div
                  className="text-gray-300 text-sm [&_a]:text-accent-400 [&_a]:hover:underline"
                  dangerouslySetInnerHTML={{
                    __html: followUp.contentHtml || `<p>${followUp.content.replace(/\n/g, "<br>")}</p>`,
                  }}
                />
                <div className="mt-2">
                  <Link
                    href={`/post/${followUp.slug}`}
                    className="text-xs text-accent-400 hover:text-accent-300"
                  >
                    View follow-up thread →
                  </Link>
                </div>
              </div>
            ))}

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
                <div className="text-gray-400 text-sm [&_a]:text-accent-400 [&_a]:hover:underline" dangerouslySetInnerHTML={{ __html: sanitizeHtml(reply.content || "") }} />
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
                {isAdmin && reply.isOwn && reply.rawContent !== null && (
                  <div className="mt-2">
                    <EditReplyForm replyId={reply.id} initialContent={reply.rawContent} />
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

        {/* Author follow-up form — admin only, only on top-level posts */}
        {isAdmin && !post.inReplyToPostId && (
          <div className="mb-8">
            <AuthorFollowUpForm postId={post.id} />
          </div>
        )}

        {/* Guest comment form */}
        <GuestCommentForm postId={post.id} />
      </section>
    </article>
  );
}
