import Link from "next/link";
import type { FeedPost } from "@/components/feed/PostFeed";

/** Markdown → one-line plain text for a note's preview (mirrors PostCard's strip). */
function previewLine(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
    .replace(/^#{1,6}\s+/gm, "") // heading markers (not #hashtags)
    .replace(/[*_~`>]/g, "") // bold/italic/strike/code/quote markers
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The `list` feed variant (#250, Phase 3) — a compact, date-led index: more
 * posts per screen, reading-first, no cover images. The counterpart to the
 * default glass `cards`. Titled posts show their title; untitled notes show a
 * one-line preview.
 */
export default function FeedList({ posts }: { posts: FeedPost[] }) {
  return (
    <ul className="divide-y divide-surface-700/40">
      {posts.map((post) => {
        const preview = post.excerpt?.trim() || previewLine(post.content);
        const heading = post.title?.trim() || preview;
        const isArticle = post.category === "article";
        return (
          <li key={post.id}>
            <Link
              href={`/post/${post.slug}`}
              className="group flex flex-col gap-1 py-5 sm:flex-row sm:items-baseline sm:gap-4"
            >
              <time className="shrink-0 font-mono text-xs text-accent-400 sm:w-28 sm:pt-0.5">
                {post.publishedAt.toLocaleDateString("en-AU", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </time>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-base font-medium text-white transition-colors group-hover:text-accent-400">
                  {heading || "Untitled"}
                </h3>
                {post.title?.trim() && preview && (
                  <p className="mt-1 truncate text-sm text-gray-500">{preview}</p>
                )}
                <span className="mt-1 inline-block text-[11px] uppercase tracking-wider text-gray-600">
                  {isArticle ? "Article" : post.category}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
