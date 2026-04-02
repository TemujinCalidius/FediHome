import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";

export async function GET() {
  const following = await prisma.fediFollowing.findMany();

  return NextResponse.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${siteUrl}/ap/following`,
      type: "OrderedCollection",
      totalItems: following.length,
      orderedItems: following.map((f) => f.actorUri),
    },
    {
      headers: { "Content-Type": "application/activity+json; charset=utf-8" },
    }
  );
}
