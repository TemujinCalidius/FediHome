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
/**
 * Resolve the target post author's inbox (server-side, #110) and whether they
 * already follow us. Falls back to the client-supplied inbox only if the actor
 * can't be resolved. The `isFollower` flag lets boost delivery skip the direct
 * author send when deliverToFollowers already covers them — so a follower-author
 * isn't sent the same activity twice. (#119)
 */
async function resolveTarget(
  postApId: string,
  clientInbox: unknown
): Promise<{ inbox: string | null; isFollower: boolean }> {
  const fallback = typeof clientInbox === "string" ? clientInbox : null;
  try {
    const post = await prisma.fediPost.findUnique({
      where: { apId: postApId },
      select: { actorUri: true },
    });
    if (!post) return { inbox: fallback, isFollower: false };
    const follower = await prisma.fediFollower.findUnique({
      where: { actorUri: post.actorUri },
      select: { inbox: true, sharedInbox: true },
    });
    if (follower) return { inbox: follower.sharedInbox || follower.inbox, isFollower: true };
    const inbox = await resolveActorInbox(post.actorUri);
    return { inbox: inbox || fallback, isFollower: false };
  } catch {
    return { inbox: fallback, isFollower: false };
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

  // A Like is delivered only to the liked post's author — not broadcast to our
  // followers (that's non-standard, and would double-send to a follower-author). (#119)
  const { inbox: likeTarget } = await resolveTarget(postApId, likeInbox);
  if (likeTarget) {
    await deliverActivity(likeTarget, likeActivity).catch(() => {});
  }

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

  // A boost belongs in our followers' feeds and also notifies the original
  // author — but skip the direct author delivery when they already follow us, so
  // a follower-author isn't sent the Announce twice. (#119)
  await deliverToFollowers(announceActivity).catch(() => {});
  const boostAuthor = await resolveTarget(boostApId, boostInbox);
  if (boostAuthor.inbox && !boostAuthor.isFollower) {
    await deliverActivity(boostAuthor.inbox, announceActivity).catch(() => {});
  }

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

  // Mirror like: the Undo goes only to the author (likes aren't broadcast). (#119)
  const { inbox: target } = await resolveTarget(postApId, likeInbox);
  if (target) {
    await deliverActivity(target, undoActivity).catch(() => {});
  }

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

  // Mirror boost: tell our followers to drop it, plus the author directly unless
  // they already follow us (avoids the double-send). (#119)
  await deliverToFollowers(undoActivity).catch(() => {});
  const unboostAuthor = await resolveTarget(boostApId, boostInbox);
  if (unboostAuthor.inbox && !unboostAuthor.isFollower) {
    await deliverActivity(unboostAuthor.inbox, undoActivity).catch(() => {});
  }

  await prisma.fediPost.updateMany({ where: { apId: boostApId }, data: { boostedByMe: false } });

  return NextResponse.json({ success: true });
}
