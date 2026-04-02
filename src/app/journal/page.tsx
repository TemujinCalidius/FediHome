export const dynamic = "force-dynamic";

import { prisma } from "@/lib/db";
import PostCard from "@/components/blog/PostCard";
import Pagination from "@/components/ui/Pagination";

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

  const where = { published: true, category: { in: ["journal", "note"] } };
  const totalPosts = await prisma.post.count({ where });
  const totalPages = Math.ceil(totalPosts / POSTS_PER_PAGE);

  const posts = await prisma.post.findMany({
    where,
    orderBy: { publishedAt: "desc" },
    take: POSTS_PER_PAGE,
    skip: (page - 1) * POSTS_PER_PAGE,
  });

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
        <div className="space-y-12">
          {posts.map((post) => (
            <PostCard key={post.id} {...post} />
          ))}
        </div>
      )}

      <Pagination currentPage={page} totalPages={totalPages} basePath="/journal" />
    </div>
  );
}
