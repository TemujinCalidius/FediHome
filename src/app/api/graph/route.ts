import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";

/**
 * Read-scoped social graph — the owner's followers and following across
 * Fediverse + Bluesky, in the same merged shape the timeline uses. Cookie OR a
 * `read`-scoped bearer token (a native app). GET is read-only → no CSRF.
 */
export async function GET(req: NextRequest) {
  if (!(await authenticateApiRequest(req, "read")).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [following, followers, bskyFollowers, bskyFollowing] = await Promise.all([
    prisma.fediFollowing.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.fediFollower.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.blueskyFollower.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.blueskyFollowing.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  const mergedFollowers = [
    ...followers.map((f) => ({
      source: "fedi" as const,
      id: f.id,
      actorUri: f.actorUri,
      username: f.username,
      domain: f.domain,
      displayName: f.displayName,
      avatarUrl: f.avatarUrl,
      createdAt: f.createdAt,
    })),
    ...bskyFollowers.map((b) => ({
      source: "bsky" as const,
      id: b.id,
      did: b.did,
      handle: b.handle,
      displayName: b.displayName,
      avatarUrl: b.avatarUrl,
      createdAt: b.createdAt,
    })),
  ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

  const mergedFollowing = [
    ...following.map((f) => ({
      source: "fedi" as const,
      id: f.id,
      actorUri: f.actorUri,
      username: f.username,
      domain: f.domain,
      displayName: f.displayName,
      avatarUrl: f.avatarUrl,
      createdAt: f.createdAt,
    })),
    ...bskyFollowing.map((b) => ({
      source: "bsky" as const,
      id: b.id,
      did: b.did,
      handle: b.handle,
      followUri: b.followUri,
      displayName: b.displayName,
      avatarUrl: b.avatarUrl,
      createdAt: b.createdAt,
    })),
  ].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

  return NextResponse.json({
    followers: mergedFollowers,
    following: mergedFollowing,
    counts: {
      followers: followers.length + bskyFollowers.length,
      following: following.length + bskyFollowing.length,
    },
  });
}
