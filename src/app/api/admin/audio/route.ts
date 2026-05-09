import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const audios = await prisma.audio.findMany({
    orderBy: [{ hero: "desc" }, { heroOrder: "asc" }, { publishedAt: "desc" }],
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      mp3Path: true,
      durationSec: true,
      fileSize: true,
      coverImage: true,
      category: true,
      published: true,
      hero: true,
      heroOrder: true,
      publishedAt: true,
    },
  });

  return NextResponse.json({
    audios: audios.map((a) => ({ ...a, publishedAt: a.publishedAt.toISOString() })),
  });
}
