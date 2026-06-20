import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildPostObject } from "@/lib/ap-post";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";

export async function GET() {
  const posts = await prisma.post.findMany({
    where: { published: true, apId: { not: null } },
    orderBy: { publishedAt: "desc" },
    take: 50,
    include: { inReplyTo: { select: { apId: true } } },
  });

  const items = posts.map((post) => ({
    type: "Create",
    actor: `${siteUrl}/ap/actor`,
    published: post.publishedAt.toISOString(),
    object: buildPostObject(post),
  }));

  return NextResponse.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${siteUrl}/ap/outbox`,
      type: "OrderedCollection",
      totalItems: items.length,
      orderedItems: items,
    },
    {
      headers: { "Content-Type": "application/activity+json; charset=utf-8" },
    }
  );
}
