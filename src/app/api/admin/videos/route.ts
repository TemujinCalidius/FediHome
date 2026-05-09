import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const videos = await prisma.video.findMany({
    orderBy: [{ hero: "desc" }, { heroOrder: "asc" }, { publishedAt: "desc" }],
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      embedUrl: true,
      embedHost: true,
      iframeSrc: true,
      thumbnailUrl: true,
      duration: true,
      category: true,
      published: true,
      hero: true,
      heroOrder: true,
      publishedAt: true,
    },
  });

  return NextResponse.json({
    videos: videos.map((v) => ({ ...v, publishedAt: v.publishedAt.toISOString() })),
  });
}
