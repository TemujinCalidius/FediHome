export const dynamic = "force-dynamic";

import { prisma } from "@/lib/db";
import PostFeed from "@/components/feed/PostFeed";
import Pagination from "@/components/ui/Pagination";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { resolveLayout } from "@/lib/themes";

export const metadata = {
  title: "The Journal",
  description: "Captain's Log — thoughts, reflections, and updates.",
};

const POSTS_PER_PAGE = 15;

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10));

  const where = {
    published: true,
    category: { in: ["journal", "note"] },
    inReplyToPostId: null,
  };
  const totalPosts = await prisma.post.count({ where });
  const totalPages = Math.ceil(totalPosts / POSTS_PER_PAGE);

  const posts = await prisma.post.findMany({
    where,
    orderBy: { publishedAt: "desc" },
    take: POSTS_PER_PAGE,
    skip: (page - 1) * POSTS_PER_PAGE,
  });

  const site = await getRuntimeSiteConfig();
  const feedVariant = resolveLayout(site.theme.id, site.layout).feed;

  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-2">
        The Journal
      </h1>
      <p className="text-gray-500 mb-10">
        Captain&apos;s Log &mdash; thoughts, reflections, and updates.
      </p>

      {posts.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-gray-500">No journal entries yet.</p>
        </div>
      ) : (
        <PostFeed variant={feedVariant} posts={posts} />
      )}

      <Pagination currentPage={page} totalPages={totalPages} basePath="/journal" />
    </div>
  );
}
