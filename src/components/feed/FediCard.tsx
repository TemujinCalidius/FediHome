import { sanitizeHtml } from "@/lib/sanitize";
import type { FediPost } from "@/generated/prisma/client";

/** Canonical source URL for a post (apId is usually the URL); null if unknown. */
export function sourceUrl(apId: string): string | null {
  return apId.startsWith("http") ? apId : null;
}

function fmtCount(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : String(n);
}

/**
 * The `cards` variant of a public Fediverse-feed post — a full glass card with
 * author, content, media, link embed and read-only counts. Extracted verbatim
 * from the /fediverse page so the feed can dispatch on `layout.feed` (#267);
 * `FediList` is the compact counterpart.
 */
export default function FediCard({ post }: { post: FediPost }) {
  const handle = `@${post.username}@${post.domain}`;
  const images = post.mediaUrls
    .map((url, i) => ({ url, type: post.mediaTypes[i], i }))
    .filter((m) => m.type !== "video");
  const videos = post.mediaUrls
    .map((url, i) => ({ url, type: post.mediaTypes[i], i }))
    .filter((m) => m.type === "video");
  const src = sourceUrl(post.apId);
  const countsLoaded = Boolean(post.countsFetchedAt);

  return (
    <article className="glass-card p-5">
      {/* Author */}
      <div className="flex items-center gap-3 mb-3">
        {post.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.avatarUrl} alt="" className="w-10 h-10 rounded-full" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-surface-700" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">
            {post.displayName || post.username}
          </p>
          <p className="text-xs text-gray-600 truncate">
            {handle} &middot;{" "}
            {new Date(post.publishedAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Content */}
      <div
        className="text-gray-400 text-sm leading-relaxed break-words [&_a]:text-accent-400 [&_a]:hover:underline"
        dangerouslySetInnerHTML={{
          __html: post.contentHtml ? sanitizeHtml(post.contentHtml) : "",
        }}
      />

      {/* Media */}
      {images.length > 0 && (
        <div className={`mt-3 grid gap-2 ${images.length > 1 ? "grid-cols-2" : ""}`}>
          {images.map((m) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={m.i} src={m.url} alt="" className="rounded-lg max-h-80 object-cover w-full" />
          ))}
        </div>
      )}
      {videos.map((m) => (
        <video
          key={m.i}
          src={m.url}
          controls
          playsInline
          preload="metadata"
          className="mt-3 rounded-lg max-h-80 w-full bg-black"
        />
      ))}

      {/* Link preview embed */}
      {post.embedUrl && (post.embedTitle || post.embedDescription) && (
        <a
          href={post.embedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block border border-surface-600/50 rounded-lg overflow-hidden hover:border-surface-600 transition-colors bg-surface-800/50"
        >
          {post.embedImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.embedImage} alt="" className="w-full h-40 object-cover" />
          )}
          <div className="p-3">
            {post.embedTitle && (
              <p className="text-sm font-semibold text-white line-clamp-2">{post.embedTitle}</p>
            )}
            {post.embedDescription && (
              <p className="text-xs text-gray-500 mt-1 line-clamp-2">{post.embedDescription}</p>
            )}
          </div>
        </a>
      )}

      {/* Read-only meta strip — static counts + link to the original. No actions. */}
      <div className="mt-3 pt-2 border-t border-surface-700 flex items-center gap-3 text-xs text-gray-600">
        {countsLoaded && (
          <span>
            💬 {fmtCount(post.replyCount)}
            <span className="mx-1.5 text-gray-700">·</span>
            🔁 {fmtCount(post.boostCount)}
            <span className="mx-1.5 text-gray-700">·</span>
            ❤ {fmtCount(post.likeCount)}
          </span>
        )}
        {src && (
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto hover:text-accent-400 transition-colors"
          >
            View original ↗
          </a>
        )}
      </div>
    </article>
  );
}
