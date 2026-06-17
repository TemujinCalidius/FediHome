/**
 * Cleanup script for old federated media.
 * Deletes proxied images/embeds from public/uploads/fedi/ older than N months.
 * Does NOT delete FediPost records — just clears their media references.
 * Does NOT touch anything outside uploads/fedi/ (user's own uploads are safe).
 *
 * Usage: DATABASE_URL="..." npx tsx scripts/cleanup-fedi-media.ts [months]
 * Default: 3 months
 */

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { unlink } from "fs/promises";
import path from "path";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const months = parseInt(process.argv[2] || "3", 10);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  console.log(`Cleaning up fedi media older than ${months} months (before ${cutoff.toISOString()})`);

  const oldPosts = await prisma.fediPost.findMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [
        { mediaUrls: { isEmpty: false } },
        { embedImage: { not: null } },
      ],
    },
  });

  console.log(`Found ${oldPosts.length} posts with media to clean up`);

  let filesDeleted = 0;
  let postsUpdated = 0;

  for (const post of oldPosts) {
    const filesToDelete: string[] = [];

    // Collect local fedi media paths
    for (const url of post.mediaUrls) {
      if (url.startsWith("/uploads/fedi/")) {
        filesToDelete.push(path.join(process.cwd(), "public", url));
      }
    }
    if (post.embedImage?.startsWith("/uploads/fedi/")) {
      filesToDelete.push(path.join(process.cwd(), "public", post.embedImage));
    }

    // Delete files
    for (const filePath of filesToDelete) {
      try {
        await unlink(filePath);
        filesDeleted++;
      } catch {
        // File may already be gone
      }
    }

    // Clear media references on the post (keep the post itself)
    if (filesToDelete.length > 0) {
      await prisma.fediPost.update({
        where: { id: post.id },
        data: {
          mediaUrls: [],
          mediaTypes: [],
          embedImage: null,
        },
      });
      postsUpdated++;
    }
  }

  console.log(`Done: ${filesDeleted} files deleted, ${postsUpdated} posts updated`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
