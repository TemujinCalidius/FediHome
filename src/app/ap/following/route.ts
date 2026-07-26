import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { getSiteUrl } from "@/lib/identity";


export async function GET() {
  const hidden = (await getRuntimeSiteConfig()).hideSocialGraph;
  const following = hidden ? [] : await prisma.fediFollowing.findMany();
  const totalItems = hidden ? await prisma.fediFollowing.count() : following.length;

  const collection: Record<string, unknown> = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${getSiteUrl()}/ap/following`,
    type: "OrderedCollection",
    totalItems,
  };
  // Mastodon-compatible: when hidden, report the count but don't enumerate members.
  if (!hidden) collection.orderedItems = following.map((f) => f.actorUri);

  return NextResponse.json(collection, {
    headers: { "Content-Type": "application/activity+json; charset=utf-8" },
  });
}
