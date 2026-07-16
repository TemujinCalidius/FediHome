export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { siteConfig } from "@/../site.config";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { resolveLayout } from "@/lib/themes";
import FediFeed from "@/components/feed/FediFeed";

const MAX_POSTS = 50;

export async function generateMetadata() {
  const site = await getRuntimeSiteConfig();
  return {
    title: site.publicFeedTitle,
    description: `A read-only view of the Fediverse accounts ${site.name} follows.`,
  };
}

export default async function FediversePage() {
  const site = await getRuntimeSiteConfig();
  // Route only exists when the operator opts in.
  if (!site.publicFeed) notFound();

  const feedVariant = resolveLayout(site.theme.id, site.layout).feed;

  const posts = await prisma.fediPost.findMany({
    where: { inReplyTo: null, boostedBy: null },
    orderBy: { publishedAt: "desc" },
    take: MAX_POSTS,
  });

  return (
    <div className="max-w-2xl mx-auto px-6 py-12 md:py-16">
      <header className="mb-8">
        <h1 className="font-display text-2xl md:text-3xl font-bold text-white">
          {site.publicFeedTitle}
        </h1>
        <p className="mt-2 text-gray-400 leading-relaxed">
          A read-only window into the Fediverse accounts{" "}
          <span className="text-accent-400">{siteConfig.fediAddress}</span>{" "}
          follows — the same feed the owner sees behind the scenes. Liking,
          boosting and replying happen from your own instance; run your own{" "}
          <a
            href={site.landing.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-400 hover:underline"
          >
            FediHome
          </a>{" "}
          to join in.
        </p>
      </header>

      {posts.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-gray-500">
            Nothing here yet — once this instance follows accounts on the
            Fediverse, their posts will appear in this feed.
          </p>
        </div>
      ) : (
        <FediFeed variant={feedVariant} posts={posts} />
      )}
    </div>
  );
}
