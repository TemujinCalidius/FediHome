export const dynamic = "force-dynamic";

import { prisma } from "@/lib/db";
import PhotoGrid from "@/components/photography/PhotoGrid";

export const metadata = {
  title: "Photography",
  description: "Photography — wildlife, macro, landscape, and more.",
};

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "wildlife", label: "Wildlife" },
  { key: "macro", label: "Macro" },
  { key: "landscape", label: "Landscape" },
  { key: "street", label: "Street" },
  { key: "general", label: "General" },
];

export default async function PhotographyPage() {
  const photos = await prisma.photo.findMany({
    where: { published: true },
    orderBy: { publishedAt: "desc" },
  });

  return (
    <div className="max-w-6xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-2">
        Photography
      </h1>
      <p className="text-gray-500 mb-10">
        Captured moments &mdash; wildlife, nature, landscapes, and everything in between.
      </p>

      <PhotoGrid
        photos={JSON.parse(JSON.stringify(photos))}
        categories={CATEGORIES}
      />
    </div>
  );
}
