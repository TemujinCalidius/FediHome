#!/usr/bin/env tsx
/**
 * Reads intrinsic pixel dimensions for every Photo lacking width/height
 * and writes them in. Required for the masonry layout on /photography
 * to render without layout collapse.
 *
 * Run once: npm run backfill-photo-dimensions
 */
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { join } from "node:path";
import { existsSync } from "node:fs";

const prisma = new PrismaClient();

function localPathFor(imagePath: string): string | null {
  // Strip query string (e.g. ?w=300) — file on disk has none
  const cleaned = imagePath.split("?")[0];
  // Strip protocol/host if present — locally-served images on this host
  const pathOnly = cleaned.replace(/^https?:\/\/[^/]+/, "");
  const cwd = process.cwd();
  const candidates = [
    join(cwd, "public", pathOnly),
    join(cwd, pathOnly.replace(/^\//, "")),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function main() {
  const photos = await prisma.photo.findMany({
    where: {
      OR: [{ width: null }, { height: null }],
    },
    select: { id: true, imagePath: true, slug: true },
  });

  console.log(`Found ${photos.length} photo(s) needing dimensions.`);

  let success = 0;
  let failed = 0;

  for (const p of photos) {
    const local = localPathFor(p.imagePath);
    if (!local) {
      console.log(`  skip ${p.slug}: cannot resolve local path for ${p.imagePath}`);
      failed++;
      continue;
    }
    try {
      const meta = await sharp(local).metadata();
      if (!meta.width || !meta.height) {
        console.log(`  skip ${p.slug}: sharp returned no dimensions`);
        failed++;
        continue;
      }
      await prisma.photo.update({
        where: { id: p.id },
        data: { width: meta.width, height: meta.height },
      });
      console.log(`  ${p.slug}: ${meta.width}x${meta.height}`);
      success++;
    } catch (err) {
      console.log(`  fail ${p.slug}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${success} updated, ${failed} skipped.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Backfill failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
