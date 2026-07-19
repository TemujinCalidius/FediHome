export const dynamic = "force-dynamic";

import { prisma } from "@/lib/db";
import PhotoGrid from "@/components/photography/PhotoGrid";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { unionCategories, buildCategoryTabs } from "@/lib/categories";

export const metadata = {
  title: "Photography",
  description: "A photo gallery.",
};

export default async function PhotographyPage() {
  const [photos, present, cfg] = await Promise.all([
    prisma.photo.findMany({ where: { published: true }, orderBy: { publishedAt: "desc" } }),
    prisma.photo.findMany({ where: { published: true }, distinct: ["category"], select: { category: true } }),
    getRuntimeSiteConfig(),
  ]);
  // Filter tabs = the owner's configured list + any category still in use, so
  // removing one from settings never hides existing photos (#284).
  const categories = buildCategoryTabs(unionCategories(cfg.categories.photos, present.map((p) => p.category)));

  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-2">
        Photography
      </h1>
      <p className="text-gray-500 mb-10">
        Captured moments.
      </p>

      <PhotoGrid
        photos={JSON.parse(JSON.stringify(photos))}
        categories={categories}
      />
    </div>
  );
}
