import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { getSiteUrl } from "@/lib/identity";


export async function GET() {
  const hidden = (await getRuntimeSiteConfig()).hideSocialGraph;
  const followers = hidden
    ? []
    : await prisma.fediFollower.findMany({ where: { accepted: true } });
  const totalItems = hidden
    ? await prisma.fediFollower.count({ where: { accepted: true } })
    : followers.length;

  const collection: Record<string, unknown> = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${getSiteUrl()}/ap/followers`,
    type: "OrderedCollection",
    totalItems,
  };
  // Mastodon-compatible: when hidden, report the count but don't enumerate members.
  if (!hidden) collection.orderedItems = followers.map((f) => f.actorUri);

  return NextResponse.json(collection, {
    headers: { "Content-Type": "application/activity+json; charset=utf-8" },
  });
}
