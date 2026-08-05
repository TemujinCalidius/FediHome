import { prisma } from "@/lib/db";
import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "@/lib/site-profile";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { buildNavLinks, type NavLink } from "@/lib/nav";
import { postOgDescription } from "@/lib/og";

/**
 * Shared sidebar data (#250) — everything the `sidebar` shell variant's blocks
 * need. Mirrors the `footerData` loader idiom: one `Promise.all` over sources
 * that are already cached (runtime config + profile are 60s-cached), so the
 * whole sidebar costs one extra small query per request, and ONLY when the
 * owner has opted into the sidebar shell.
 */

const RECENT_LIMIT = 5;

/**
 * A 300px column, two lines of text. The OG description's 200 characters would
 * be clipped mid-word by `line-clamp-2` on most screens, so the snippet is cut
 * shorter here and given a real ellipsis rather than a CSS one — a fade is fine
 * for a paragraph and unreadable for a five-item list.
 */
const SNIPPET_CHARS = 80;

export interface SidebarRecentPost {
  slug: string;
  title: string | null;
  publishedAt: string;
  /**
   * What to show when there is no title (#307 item 3). A note legitimately has
   * none, so a microblog rendered a column of "Untitled" — the same problem
   * #253 fixed for `GET /api/posts`, and fixed the same way, so the sidebar, the
   * API and the Mac app all describe a title-less post identically.
   *
   * Empty when the post has no usable text either (a photo-only note); the
   * component falls back to the date alone, which is at least true.
   */
  snippet: string;
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
        // excerpt/contentHtml/content are what postOgDescription needs. Costs
        // more per row than the old three columns, but it is five rows on a
        // page the owner opted into.
        select: {
          slug: true, title: true, publishedAt: true,
          excerpt: true, contentHtml: true, content: true,
        },
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
      // "" rather than the site description: a genuinely empty post should stay
      // empty here so the component can fall back to the date, exactly as the
      // API list payload does (#253). The site tagline repeated five times down
      // a sidebar would be worse than "Untitled" was.
      snippet: p.title ? "" : truncate(postOgDescription(p, ""), SNIPPET_CHARS),
    })),
    fediAddress: siteConfig.fediAddress,
    // Prefer the web-editable contact email, falling back to the env default.
    contactEmail: site.contact.email || siteConfig.contactEmail,
    footer: site.footer,
  };
}

/** Cut on a word boundary where there is one, so the tail isn't a half-word. */
function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
