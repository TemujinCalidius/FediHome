#!/usr/bin/env tsx
/**
 * Reads intrinsic pixel dimensions for every Photo lacking width/height
 * and writes them in. Required for the masonry layout on /photography
 * to render without layout collapse.
 *
 * Run once: npm run backfill-photo-dimensions
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import sharp from "sharp";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveUploadPath } from "../src/lib/uploads-dir";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function localPathFor(imagePath: string): Promise<string | null> {
  // Strip query string (e.g. ?w=300) — file on disk has none
  const cleaned = imagePath.split("?")[0];
  // Strip protocol/host if present — locally-served images on this host
  const pathOnly = cleaned.replace(/^https?:\/\/[^/]+/, "");
  // Uploads may live outside the checkout (#363); everything else still
  // resolves against the project root.
  if (pathOnly.startsWith("/uploads/")) {
    const abs = await resolveUploadPath(pathOnly);
    if (abs && existsSync(abs)) return abs;
  }
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
    const local = await localPathFor(p.imagePath);
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
