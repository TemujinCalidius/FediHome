import Link from "next/link";
import Image from "next/image";

function linkHashtagsHtml(text: string): string {
  // Escape HTML first, then link URLs and hashtags
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const withLinks = escaped.replace(
    /(https?:\/\/[^\s<&]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-accent-400 hover:underline">$1</a>'
  );
  return withLinks.replace(
    /#([a-zA-Z0-9_]+)/g,
    '<a href="https://mastodon.social/tags/$1" target="_blank" rel="noopener noreferrer" class="text-accent-400 hover:underline">&#35;$1</a>'
  );
}

interface PostCardProps {
  slug: string;
  title?: string | null;
  excerpt?: string | null;
  content: string;
  category: string;
  publishedAt: Date;
  coverImage?: string | null;
  photos?: string[];
  likeCount: number;
  boostCount: number;
  bskyLikeCount?: number;
  bskyRepostCount?: number;
}

export default function PostCard({
  slug,
  title,
  excerpt,
  content,
  category,
  publishedAt,
  coverImage,
  photos,
  likeCount,
  boostCount,
  bskyLikeCount = 0,
  bskyRepostCount = 0,
}: PostCardProps) {
  const totalLikes = likeCount + bskyLikeCount;
  const totalBoosts = boostCount + bskyRepostCount;
  // Strip markdown syntax for preview but keep hashtags
  const plainText = content
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "") // remove images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
    .replace(/^#{1,6}\s+/gm, "") // remove heading markers (but not #hashtags)
    .replace(/[*_~`>]/g, "") // remove bold/italic/strike/code/quote markers
    .trim();
  const displayText = excerpt || plainText.slice(0, 280);
  const hasImage = coverImage || (photos && photos.length > 0);
  const imageUrl = coverImage || photos?.[0];
  // Show a "read more" cue when the card only shows part of the post — always for
  // articles (the card shows their summary), or when a note was truncated.
  const isArticle = category === "article";
  const hasMore = isArticle || !!excerpt || plainText.length > 280;

  return (
    <Link href={`/post/${slug}`} className="block">
      <article className="bg-surface-900/90 border border-surface-600/30 rounded-xl p-6 group cursor-pointer hover:border-accent-400/20 transition-colors">
        <div className="flex items-center gap-3 mb-3">
          <time className="text-xs text-accent-400 font-mono">
            {publishedAt.toLocaleDateString("en-AU", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </time>
          <span className="text-xs text-gray-600 uppercase tracking-wider">
            {category}
          </span>
        </div>

        {hasImage && imageUrl && (
          <div className="relative w-full h-56 rounded-lg mb-3 overflow-hidden bg-surface-800">
            <Image
              src={imageUrl}
              alt={title || ""}
              fill
              className="object-cover group-hover:scale-[1.02] transition-transform duration-300"
            />
          </div>
        )}

        {title && (
          <h3 className="font-display text-lg font-semibold text-white mb-2 group-hover:text-accent-400 transition-colors">
            {title}
          </h3>
        )}

        <p
          className="text-gray-400 leading-relaxed text-sm"
          dangerouslySetInnerHTML={{
            __html: linkHashtagsHtml(displayText) + (content.length > 280 && !excerpt ? "..." : ""),
          }}
        />

        {/* Read-more cue — the whole card is already a link; this just signals
            there's more behind the summary (esp. for articles). */}
        {hasMore && (
          <span className="inline-flex items-center gap-1 mt-3 text-sm font-medium text-accent-400 group-hover:gap-2 transition-all">
            {isArticle ? "Read article" : "Read more"}
            <span aria-hidden="true">→</span>
          </span>
        )}

        {/* Fedi interactions */}
        {(totalLikes > 0 || totalBoosts > 0) && (
          <div className="flex gap-3 mt-3">
            {totalLikes > 0 && (
              <span className="fedi-badge">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" />
                </svg>
                {totalLikes}
              </span>
            )}
            {totalBoosts > 0 && (
              <span className="fedi-badge">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
                </svg>
                {totalBoosts}
              </span>
            )}
          </div>
        )}
      </article>
    </Link>
  );
}
