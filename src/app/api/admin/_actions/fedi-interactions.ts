import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverActivity, deliverToFollowers } from "@/lib/http-signatures";
import { siteConfig } from "@/../site.config";
import type { AdminBody } from "./types";

const siteUrl = siteConfig.url;

export async function like(body: AdminBody): Promise<NextResponse> {
  // Like a fedi post
  const { postApId, targetInbox: likeInbox } = body;
  if (!postApId) {
    return NextResponse.json({ error: "postApId required" }, { status: 400 });
  }

  const likeActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteUrl}/ap/like/${Date.now()}`,
    type: "Like",
    actor: `${siteUrl}/ap/actor`,
    object: postApId,
  };

  if (likeInbox) {
    await deliverActivity(likeInbox, likeActivity).catch(() => {});
  }
  await deliverToFollowers(likeActivity).catch(() => {});

  // Remember we liked it so the button stays lit after a reload.
  await prisma.fediPost.updateMany({ where: { apId: postApId }, data: { likedByMe: true } });

  return NextResponse.json({ success: true });
}

export async function boost(body: AdminBody): Promise<NextResponse> {
  // Boost/announce a fedi post
  const { postApId: boostApId, targetInbox: boostInbox } = body;
  if (!boostApId) {
    return NextResponse.json({ error: "postApId required" }, { status: 400 });
  }

  const announceActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteUrl}/ap/announce/${Date.now()}`,
    type: "Announce",
    actor: `${siteUrl}/ap/actor`,
    object: boostApId,
    published: new Date().toISOString(),
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${siteUrl}/ap/followers`],
  };

  if (boostInbox) {
    await deliverActivity(boostInbox, announceActivity).catch(() => {});
  }
  await deliverToFollowers(announceActivity).catch(() => {});

  // Remember we boosted it so the button stays lit after a reload.
  await prisma.fediPost.updateMany({ where: { apId: boostApId }, data: { boostedByMe: true } });

  return NextResponse.json({ success: true });
}
