import { htmlToText } from "@/lib/html-text";
import { sourceUrl } from "@/components/feed/FediCard";
import type { FediPost } from "@/generated/prisma/client";

/**
 * The `list` variant of the public Fediverse feed (#267) — a compact, dense row
 * per post: small avatar, author + handle + date, a one-line text snippet, and
 * a link to the original. Drops media/embeds/counts for density (the counterpart
 * to `FediCard`), matching the reading-first spirit of the own-post `FeedList`.
 */
export default function FediList({ posts }: { posts: FediPost[] }) {
  return (
    <ul className="divide-y divide-surface-700/40">
      {posts.map((post) => {
        const handle = `@${post.username}@${post.domain}`;
        const src = sourceUrl(post.apId);
        // Plain-text snippet — never rendered as HTML (htmlToText strips tags).
        const snippet = htmlToText(post.contentHtml ?? post.content ?? "", 150);
        return (
          <li key={post.id} className="flex items-start gap-3 py-4">
            {post.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={post.avatarUrl} alt="" className="mt-0.5 h-9 w-9 shrink-0 rounded-full" />
            ) : (
              <div className="mt-0.5 h-9 w-9 shrink-0 rounded-full bg-surface-700" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                <span className="font-semibold text-white">{post.displayName || post.username}</span>
                <span className="text-gray-600">
                  {" "}{handle} &middot; {new Date(post.publishedAt).toLocaleDateString()}
                </span>
              </p>
              {snippet && (
                <p className="mt-0.5 line-clamp-2 break-words text-sm text-gray-400">{snippet}</p>
              )}
            </div>
            {src && (
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View original"
                className="shrink-0 pt-0.5 text-xs text-gray-600 transition-colors hover:text-accent-400"
              >
                ↗
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
