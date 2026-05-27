import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin } from "@/lib/auth";

export interface MentionResult {
  kind: "fedi" | "bluesky";
  key: string;          // actorUri (fedi) or did (bluesky) — used as React key + dedup
  handle: string;       // "@user@domain" (fedi) or "@handle.bsky.social" (bluesky)
  displayName: string | null;
  avatarUrl: string | null;
  actorUri?: string;    // fedi only
  did?: string;         // bluesky only
}

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 1 || q.length > 32) {
    return NextResponse.json({ results: [] });
  }

  // Strip a leading @ so users can type "@" without losing the match
  const term = q.replace(/^@/, "");
  if (!term) return NextResponse.json({ results: [] });

  // Fediverse: followers + following matching username or displayName
  const [fediFollowers, fediFollowing] = await Promise.all([
    prisma.fediFollower.findMany({
      where: {
        OR: [
          { username: { contains: term, mode: "insensitive" } },
          { displayName: { contains: term, mode: "insensitive" } },
        ],
      },
      take: 20,
    }),
    prisma.fediFollowing.findMany({
      where: {
        OR: [
          { username: { contains: term, mode: "insensitive" } },
          { displayName: { contains: term, mode: "insensitive" } },
        ],
      },
      take: 20,
    }),
  ]);

  // Bluesky: followers + following matching handle or displayName
  const [bskyFollowers, bskyFollowing] = await Promise.all([
    prisma.blueskyFollower.findMany({
      where: {
        OR: [
          { handle: { contains: term, mode: "insensitive" } },
          { displayName: { contains: term, mode: "insensitive" } },
        ],
      },
      take: 20,
    }),
    prisma.blueskyFollowing.findMany({
      where: {
        OR: [
          { handle: { contains: term, mode: "insensitive" } },
          { displayName: { contains: term, mode: "insensitive" } },
        ],
      },
      take: 20,
    }),
  ]);

  // Build deduped result sets, followers first
  const seen = new Set<string>();
  const results: (MentionResult & { sortKey: string })[] = [];

  const pushFedi = (
    rec: { actorUri: string; username: string; domain: string; displayName: string | null; avatarUrl: string | null }
  ) => {
    if (seen.has(`fedi:${rec.actorUri}`)) return;
    seen.add(`fedi:${rec.actorUri}`);
    results.push({
      kind: "fedi",
      key: rec.actorUri,
      handle: `@${rec.username}@${rec.domain}`,
      displayName: rec.displayName,
      avatarUrl: rec.avatarUrl,
      actorUri: rec.actorUri,
      sortKey: (rec.displayName || rec.username).toLowerCase(),
    });
  };

  const pushBsky = (
    rec: { did: string; handle: string; displayName: string | null; avatarUrl: string | null }
  ) => {
    if (seen.has(`bluesky:${rec.did}`)) return;
    seen.add(`bluesky:${rec.did}`);
    results.push({
      kind: "bluesky",
      key: rec.did,
      handle: `@${rec.handle}`,
      displayName: rec.displayName,
      avatarUrl: rec.avatarUrl,
      did: rec.did,
      sortKey: (rec.displayName || rec.handle).toLowerCase(),
    });
  };

  // Followers first (more relevant — people who follow you)
  fediFollowers.forEach(pushFedi);
  bskyFollowers.forEach(pushBsky);
  // Then following (people you follow)
  fediFollowing.forEach(pushFedi);
  bskyFollowing.forEach(pushBsky);

  // Stable secondary sort by display name, but preserve "followers first" partition.
  // We split, sort each, then concat — simpler than a custom comparator.
  const followersChunk = results.slice(0, fediFollowers.length + bskyFollowers.length);
  const followingChunk = results.slice(fediFollowers.length + bskyFollowers.length);
  followersChunk.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  followingChunk.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const merged = [...followersChunk, ...followingChunk].slice(0, 10);

  // Strip sortKey before returning
  return NextResponse.json({
    results: merged.map(({ sortKey: _sortKey, ...rest }) => rest),
  });
}
