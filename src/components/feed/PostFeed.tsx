import PostCard from "@/components/blog/PostCard";
import FeedList from "@/components/feed/FeedList";
import type { FeedVariant } from "@/lib/themes";

/**
 * The fields the feed renders — the union of what the `cards` (PostCard) and
 * `list` (FeedList) variants need. A Prisma `Post` is structurally assignable,
 * so callers pass their rows straight through.
 */
export type FeedPost = {
  id: string;
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
};

/**
 * Feed region dispatcher (#250, Phase 3). Renders the owner's posts in the
 * variant the active theme/config selected. `cards` is today's look (extracted
 * verbatim), so a default instance is pixel-identical; `list` is a compact,
 * reading-first index. New variants (e.g. `blog` for the Classic Blog theme)
 * plug in here behind the same `variant` prop.
 */
export default function PostFeed({ variant, posts }: { variant: FeedVariant; posts: FeedPost[] }) {
  if (variant === "list") return <FeedList posts={posts} />;
  return (
    <div className="space-y-12">
      {posts.map((post) => (
        <PostCard key={post.id} {...post} />
      ))}
    </div>
  );
}
