export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { verifyAdminSession } from "@/lib/auth";
import { sanitizeHtml } from "@/lib/sanitize";
import { isTinylyticsConfigured, getSiteStats, getLeaderboard, getRecentHits, getUserJourneys } from "@/lib/tinylytics";
import { siteConfig } from "@/../site.config";
import TimelineClient from "./TimelineClient";
import TimelineLogin from "./TimelineLogin";

export const metadata = {
  title: "Timeline",
  description: "Your Fediverse feed.",
};

export default async function TimelinePage() {
  const cookieStore = await cookies();
  const adminToken = cookieStore.get("sl_admin")?.value;
  const isAdmin = await verifyAdminSession(adminToken);

  if (!isAdmin) {
    return <TimelineLogin />;
  }
  // Fetch first page of timeline posts (top-level only for initial load)
  const fediPostsRaw = await prisma.fediPost.findMany({
    where: { inReplyTo: null, boostedBy: null },
    orderBy: { publishedAt: "desc" },
    take: 21, // 20 + 1 to check for more
  });
  // Re-sanitize contentHtml on every emit — protects against legacy rows
  // that were stored before sanitization was tightened.
  const fediPosts = fediPostsRaw.map((p) => ({
    ...p,
    contentHtml: p.contentHtml ? sanitizeHtml(p.contentHtml) : null,
  }));
  const hasMore = fediPosts.length > 20;
  const initialPosts = hasMore ? fediPosts.slice(0, 20) : fediPosts;
  const nextCursor = hasMore
    ? initialPosts[initialPosts.length - 1].publishedAt.toISOString()
    : null;

  // Fetch following list
  const following = await prisma.fediFollowing.findMany({
    orderBy: { createdAt: "desc" },
  });

  // Fetch pending guest comments for moderation
  const pendingComments = await prisma.guestComment.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
    include: {
      post: { select: { slug: true, title: true } },
      photo: { select: { slug: true, title: true } },
    },
  });

  // Fetch followers
  const followers = await prisma.fediFollower.findMany({
    orderBy: { createdAt: "desc" },
  });

  // Fetch Bluesky graph (mirrored locally via syncBlueskyGraph)
  const [bskyFollowers, bskyFollowing] = await Promise.all([
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

  const totalFollowerCount = followers.length + bskyFollowers.length;
  const totalFollowingCount = following.length + bskyFollowing.length;

  // Fetch direct messages grouped by conversation
  const directMessagesRaw = await prisma.directMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const directMessages = directMessagesRaw.map((m) => ({
    ...m,
    contentHtml: m.contentHtml ? sanitizeHtml(m.contentHtml) : null,
  }));

  // Server-side read state — replaces the old localStorage approach so unread
  // counts sync across browsers/devices.
  const dmReadRows = await prisma.dmConversationRead.findMany();
  const dmReadState: Record<string, string> = {};
  for (const row of dmReadRows) {
    dmReadState[row.conversationKey] = row.lastReadAt.toISOString();
  }

  // Fetch analytics data (if Tinylytics is configured)
  const analyticsData = isTinylyticsConfigured()
    ? {
        stats: await getSiteStats(),
        leaderboard: await getLeaderboard(15),
        recentHits: await getRecentHits(),
        journeys: await getUserJourneys(15),
      }
    : null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-16">
      <div className="flex items-center justify-between mb-8">
        <h1 className="font-display text-3xl font-bold text-white">
          Timeline
        </h1>
        <div className="flex items-center gap-4 text-sm text-gray-500">
          <span>{totalFollowerCount} followers</span>
          <span>{totalFollowingCount} following</span>
          <a
            href="/admin/sessions"
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Sessions
          </a>
          <a
            href="/admin/apps"
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Apps
          </a>
          <a
            href="/compose"
            className="btn-primary text-xs !py-1.5"
          >
            + Compose
          </a>
        </div>
      </div>

      <TimelineClient
        initialPosts={JSON.parse(JSON.stringify(initialPosts))}
        initialCursor={nextCursor}
        following={JSON.parse(JSON.stringify(mergedFollowing))}
        followers={JSON.parse(JSON.stringify(mergedFollowers))}
        pendingComments={JSON.parse(JSON.stringify(pendingComments))}
        directMessages={JSON.parse(JSON.stringify(directMessages))}
        dmReadState={dmReadState}
        analyticsData={analyticsData ? JSON.parse(JSON.stringify(analyticsData)) : null}
        fediAddress={siteConfig.fediAddress}
      />
    </div>
  );
}
