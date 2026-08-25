export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { resolveLayout } from "@/lib/themes";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { verifyAdminSession } from "@/lib/auth";
import { sanitizeHtml } from "@/lib/sanitize";
import { isTinylyticsConfigured, getSiteStats, getLeaderboard, getRecentHits, getUserJourneys } from "@/lib/tinylytics";
import { siteConfig } from "@/../site.config";
import TimelineClient from "./TimelineClient";
import TimelineLogin from "./TimelineLogin";
import { blockedPostFilter, blockedDmSenderUris } from "@/lib/blocks";

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
    // Blocked actors excluded on read as well as at ingest (#396) — the purge
    // is reversible by any path that writes a FediPost, so the feed shouldn't
    // depend on it having held.
    // Same provenance filter as the public page and /api/feed (#460) — the
    // three must agree, or the feed changes shape the moment anything refetches.
    where: {
      inReplyTo: null,
      boostedBy: null,
      viaLookup: false,
      discoveredVia: null,
      ...(await blockedPostFilter()),
    },
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
  // Blocked actors + domains, so the moderation tab can list and undo them.
  // Until now the only web consumer of a block was creating one — /api/graph
  // carried the list for the native app, and the browser had no way to see or
  // reverse it.
  const [blockedActors, blockedDomains] = await Promise.all([
    prisma.blockedActor.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.blockedDomain.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

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
      accepted: f.accepted,
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
  // The same filter /api/dms applies, and it has to be the same one (#564):
  // the SSR paint and every client refetch disagreeing about a blocked account
  // is the #459 failure exactly. Resolved before the query so `take` stays
  // honest — a post-fetch filter would return 199 of a 200-message page.
  const blockedDmUris = await blockedDmSenderUris();
  const directMessagesRaw = await prisma.directMessage.findMany({
    where: blockedDmUris.length ? { NOT: { senderUri: { in: blockedDmUris } } } : {},
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
  const analyticsData = (await isTinylyticsConfigured())
    ? {
        stats: await getSiteStats(),
        leaderboard: await getLeaderboard(15),
        recentHits: await getRecentHits(),
        journeys: await getUserJourneys(15),
      }
    : null;

  const timelineSite = await getRuntimeSiteConfig();
  const feedVariant = resolveLayout(timelineSite.theme.id, timelineSite.layout).feed;

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
            href="/admin/audit"
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Activity
          </a>
          <a
            href="/admin/settings"
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Settings
          </a>
          <a
            href="/admin/site"
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Site
          </a>
          <a
            href="/admin/integrations"
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Integrations
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
        blockedActors={JSON.parse(JSON.stringify(blockedActors))}
        blockedDomains={JSON.parse(JSON.stringify(blockedDomains))}
        directMessages={JSON.parse(JSON.stringify(directMessages))}
        dmReadState={dmReadState}
        analyticsData={analyticsData ? JSON.parse(JSON.stringify(analyticsData)) : null}
        fediAddress={siteConfig.fediAddress}
        // The same layout.feed key the public feeds honour (#269) — the one
        // remaining feed surface that ignored it.
        feedVariant={feedVariant}
        // Whether to offer the Explore tab at all (#386). Passed down rather
        // than probed from the client, so the tab never appears for a moment and
        // then disappears — and /api/explore 404s independently, so the flag is
        // a UI affordance rather than the access check.
        exploreEnabled={timelineSite.explore.enabled}
      />
    </div>
  );
}
