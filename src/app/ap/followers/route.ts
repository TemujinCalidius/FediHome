import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";

export async function GET() {
  const followers = await prisma.fediFollower.findMany({
    where: { accepted: true },
  });

  return NextResponse.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${siteUrl}/ap/followers`,
      type: "OrderedCollection",
      totalItems: followers.length,
      orderedItems: followers.map((f) => f.actorUri),
    },
    {
      headers: { "Content-Type": "application/activity+json; charset=utf-8" },
    }
  );
}
