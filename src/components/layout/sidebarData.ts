import { prisma } from "@/lib/db";
import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "@/lib/site-profile";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { buildNavLinks, type NavLink } from "@/lib/nav";

/**
 * Shared sidebar data (#250) — everything the `sidebar` shell variant's blocks
 * need. Mirrors the `footerData` loader idiom: one `Promise.all` over sources
 * that are already cached (runtime config + profile are 60s-cached), so the
 * whole sidebar costs one extra small query per request, and ONLY when the
 * owner has opted into the sidebar shell.
 */

const RECENT_LIMIT = 5;

export interface SidebarRecentPost {
  slug: string;
  title: string | null;
  publishedAt: string;
}

export interface SidebarData {
  authorName: string;
  authorBio: string;
  authorTagline: string;
  avatarPath: string;
  navLinks: NavLink[];
  recentPosts: SidebarRecentPost[];
  fediAddress: string;
  contactEmail: string;
  footer: Awaited<ReturnType<typeof getRuntimeSiteConfig>>["footer"];
}

export async function getSidebarData(): Promise<SidebarData> {
  const [profile, site, recent] = await Promise.all([
    getRuntimeProfile(),
    getRuntimeSiteConfig(),
    // Same filter the homepage feed uses: published, and not an author
    // follow-up (those render inline on the original post).
    prisma.post
      .findMany({
        where: { published: true, inReplyToPostId: null },
        orderBy: { publishedAt: "desc" },
        take: RECENT_LIMIT,
        select: { slug: true, title: true, publishedAt: true },
      })
      .catch(() => []), // DB hiccup shouldn't take the whole page down
  ]);

  return {
    authorName: profile.authorName,
    authorBio: profile.authorBio,
    authorTagline: profile.authorTagline,
    avatarPath: profile.avatarPath,
    navLinks: buildNavLinks(site),
    recentPosts: recent.map((p) => ({
      slug: p.slug,
      title: p.title,
      publishedAt: p.publishedAt.toISOString(),
    })),
    fediAddress: siteConfig.fediAddress,
    // Prefer the web-editable contact email, falling back to the env default.
    contactEmail: site.contact.email || siteConfig.contactEmail,
    footer: site.footer,
  };
}
