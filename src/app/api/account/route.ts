import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";
import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "@/lib/site-profile";
import { getRuntimeSiteConfig } from "@/lib/site-settings";

/**
 * The owner's identity + instance info — the app's "me". Lets a connected app
 * show which instance/handle it's signed into and render a profile header.
 * Read-scoped (cookie OR a `read` bearer). GET is read-only → no CSRF.
 */
export async function GET(req: NextRequest) {
  if (!(await authenticateApiRequest(req, "read")).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [fediFollowers, bskyFollowers, fediFollowing, bskyFollowing, posts, profile, site] =
    await Promise.all([
      prisma.fediFollower.count(),
      prisma.blueskyFollower.count(),
      prisma.fediFollowing.count(),
      prisma.blueskyFollowing.count(),
      prisma.post.count({ where: { published: true } }),
      getRuntimeProfile(),
      getRuntimeSiteConfig(),
    ]);

  return NextResponse.json({
    me: siteConfig.url,
    actor: `${siteConfig.url}/ap/actor`,
    handle: siteConfig.fediHandle,
    domain: siteConfig.fediDomain,
    fediAddress: siteConfig.fediAddress,
    name: site.name,
    authorName: profile.authorName,
    bio: profile.authorBio,
    tagline: profile.authorTagline,
    summary: profile.actorSummary,
    accentColor: profile.accentColor,
    avatar: `${siteConfig.url}${profile.avatarPath}`,
    banner: `${siteConfig.url}${profile.bannerPath}`,
    counts: {
      followers: fediFollowers + bskyFollowers,
      following: fediFollowing + bskyFollowing,
      posts,
    },
  });
}
