import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { like, unlike, boost, unboost } from "./fedi-interactions";
import { blueskyLike, blueskyUnlike, blueskyRepost, blueskyUnrepost } from "./bluesky-interactions";
import type { AdminBody } from "./types";

/**
 * One entry point for like / unlike / boost / unboost, routing by the post's
 * network (#393).
 *
 * The timeline holds both ActivityPub and Bluesky posts and already knows which
 * is which, so the CLIENT shouldn't have to: it sends the row id and the server
 * looks up `source` and dispatches. Deciding it client-side would mean every
 * call site has to remember, and a single missed one silently sends an
 * ActivityPub activity for a Bluesky post — a failure that looks like nothing
 * at all, because these calls are fire-and-forget.
 */

type Kind = "like" | "unlike" | "boost" | "unboost";

const FEDI: Record<Kind, (body: AdminBody) => Promise<NextResponse>> = {
  like,
  unlike,
  boost,
  unboost,
};

const BLUESKY: Record<Kind, (bskyUri: string) => Promise<NextResponse>> = {
  like: blueskyLike,
  unlike: blueskyUnlike,
  boost: blueskyRepost,
  unboost: blueskyUnrepost,
};

export async function interact(kind: Kind, body: AdminBody): Promise<NextResponse> {
  const { postId, postApId } = body as { postId?: string; postApId?: string };

  // postId is what the client sends now: it identifies a row on either network,
  // where postApId can only ever name a fediverse one. postApId is still
  // accepted, because a browser left open across a deploy runs the old bundle
  // and its Like button would otherwise start 400ing.
  if (!postId && !postApId) {
    return NextResponse.json({ error: "postId required" }, { status: 400 });
  }

  const row = postId
    ? await prisma.fediPost.findUnique({
        where: { id: postId },
        select: { source: true, apId: true, bskyUri: true },
      })
    : null;

  if (postId && !row) {
    return NextResponse.json({ error: "post not found" }, { status: 404 });
  }

  if (row?.source === "bluesky") {
    if (!row.bskyUri) {
      return NextResponse.json({ error: "post has no Bluesky URI" }, { status: 400 });
    }
    return BLUESKY[kind](row.bskyUri);
  }

  // Fediverse. The AP actions key on apId, so hand them the row's OWN id rather
  // than trusting whatever the client sent — otherwise a caller could like one
  // post by sending its id and a different post's apId.
  const apId = row?.apId ?? postApId;
  if (!apId) {
    return NextResponse.json({ error: "post is not on a supported network" }, { status: 400 });
  }
  return FEDI[kind]({ ...body, postApId: apId });
}
