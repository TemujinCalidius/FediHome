import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";
import { siteConfig } from "@/../site.config";

/**
 * The owner's identity + instance info — the app's "me". Lets a connected app
 * show which instance/handle it's signed into and render a profile header.
 * Read-scoped (cookie OR a `read` bearer). GET is read-only → no CSRF.
 */
export async function GET(req: NextRequest) {
  if (!(await authenticateApiRequest(req, "read")).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [fediFollowers, bskyFollowers, fediFollowing, bskyFollowing, posts] =
    await Promise.all([
      prisma.fediFollower.count(),
      prisma.blueskyFollower.count(),
      prisma.fediFollowing.count(),
      prisma.blueskyFollowing.count(),
      prisma.post.count({ where: { published: true } }),
    ]);

  return NextResponse.json({
    me: siteConfig.url,
    actor: `${siteConfig.url}/ap/actor`,
    handle: siteConfig.fediHandle,
    domain: siteConfig.fediDomain,
    fediAddress: siteConfig.fediAddress,
    name: siteConfig.name,
    authorName: siteConfig.authorName,
    summary: siteConfig.actorSummary,
    avatar: `${siteConfig.url}${siteConfig.avatarPath}`,
    banner: `${siteConfig.url}${siteConfig.bannerPath}`,
    counts: {
      followers: fediFollowers + bskyFollowers,
      following: fediFollowing + bskyFollowing,
      posts,
    },
  });
}
