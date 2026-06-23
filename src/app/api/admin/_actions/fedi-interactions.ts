import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverActivity, deliverToFollowers } from "@/lib/http-signatures";
import { resolveActorInbox } from "@/lib/fedi-resolve";
import { siteConfig } from "@/../site.config";
import type { AdminBody } from "./types";

const siteUrl = siteConfig.url;

/**
 * The target post author's real inbox, resolved server-side from the stored
 * FediPost's actorUri (#110). Falls back to the client-supplied inbox only if
 * the actor can't be resolved — the client value hardcodes Mastodon's
 * /users/<name>/inbox, which 404s to FediHome and other non-Mastodon servers.
 */
async function targetAuthorInbox(postApId: string, clientInbox: unknown): Promise<string | null> {
  const fallback = typeof clientInbox === "string" ? clientInbox : null;
  try {
    const post = await prisma.fediPost.findUnique({
      where: { apId: postApId },
      select: { actorUri: true },
    });
    const resolved = post ? await resolveActorInbox(post.actorUri) : null;
    return resolved || fallback;
  } catch {
    return fallback;
  }
}

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

  const likeTarget = await targetAuthorInbox(postApId, likeInbox);
  if (likeTarget) {
    await deliverActivity(likeTarget, likeActivity).catch(() => {});
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

  const boostTarget = await targetAuthorInbox(boostApId, boostInbox);
  if (boostTarget) {
    await deliverActivity(boostTarget, announceActivity).catch(() => {});
  }
  await deliverToFollowers(announceActivity).catch(() => {});

  // Remember we boosted it so the button stays lit after a reload.
  await prisma.fediPost.updateMany({ where: { apId: boostApId }, data: { boostedByMe: true } });

  return NextResponse.json({ success: true });
}

export async function unlike(body: AdminBody): Promise<NextResponse> {
  const { postApId, targetInbox: likeInbox } = body;
  if (!postApId) {
    return NextResponse.json({ error: "postApId required" }, { status: 400 });
  }

  const undoActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteUrl}/ap/undo/${Date.now()}`,
    type: "Undo",
    actor: `${siteUrl}/ap/actor`,
    object: { type: "Like", actor: `${siteUrl}/ap/actor`, object: postApId },
  };

  const target = await targetAuthorInbox(postApId, likeInbox);
  if (target) {
    await deliverActivity(target, undoActivity).catch(() => {});
  }
  await deliverToFollowers(undoActivity).catch(() => {});

  await prisma.fediPost.updateMany({ where: { apId: postApId }, data: { likedByMe: false } });

  return NextResponse.json({ success: true });
}

export async function unboost(body: AdminBody): Promise<NextResponse> {
  const { postApId: boostApId, targetInbox: boostInbox } = body;
  if (!boostApId) {
    return NextResponse.json({ error: "postApId required" }, { status: 400 });
  }

  const undoActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteUrl}/ap/undo/${Date.now()}`,
    type: "Undo",
    actor: `${siteUrl}/ap/actor`,
    object: { type: "Announce", actor: `${siteUrl}/ap/actor`, object: boostApId },
  };

  const target = await targetAuthorInbox(boostApId, boostInbox);
  if (target) {
    await deliverActivity(target, undoActivity).catch(() => {});
  }
  await deliverToFollowers(undoActivity).catch(() => {});

  await prisma.fediPost.updateMany({ where: { apId: boostApId }, data: { boostedByMe: false } });

  return NextResponse.json({ success: true });
}
