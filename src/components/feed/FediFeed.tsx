import FediCard from "@/components/feed/FediCard";
import FediList from "@/components/feed/FediList";
import type { FediPost } from "@/generated/prisma/client";
import type { FeedVariant } from "@/lib/themes";

/**
 * Feed dispatcher for the public Fediverse feed (#267) — the FediPost analogue
 * of `PostFeed`. Honours the same `layout.feed` variant: `cards` (the default
 * glass cards, verbatim) or a compact `list`. New variants plug in here.
 */
export default function FediFeed({ variant, posts }: { variant: FeedVariant; posts: FediPost[] }) {
  if (variant === "list") return <FediList posts={posts} />;
  return (
    <div className="space-y-5">
      {posts.map((post) => (
        <FediCard key={post.id} post={post} />
      ))}
    </div>
  );
}
