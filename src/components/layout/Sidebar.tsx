import Link from "next/link";
import Image from "next/image";
import { getSidebarData } from "./sidebarData";
import { SIDEBAR_BLOCKS, type SidebarBlock } from "@/lib/sidebar";

/**
 * The sidebar column (#250) — rendered beside the page content when the owner
 * picks the `sidebar` shell variant. Styled with the existing `glass-card` idiom
 * so it inherits the active theme's surface + feel tokens.
 *
 * Which blocks appear, and in what order, is owner-configurable (#307): the
 * `blocks` list IS the render order, and omitting a block hides it. That's also
 * how you stop the header and sidebar both showing your nav — drop `sections`.
 *
 * No tags block yet: there is no public tag route, so those links would go
 * nowhere. It lands with a public `/tags/[tag]` page in a later slice.
 */
export default async function Sidebar({ blocks = SIDEBAR_BLOCKS }: { blocks?: SidebarBlock[] }) {
  const {
    authorName, authorBio, authorTagline, avatarPath,
    navLinks, recentPosts, fediAddress, contactEmail, footer,
  } = await getSidebarData();

  const block = "glass-card p-5 h-fit";
  const heading = "text-xs font-semibold text-content uppercase tracking-wider mb-3";

  // Each block renders itself or returns null when it has nothing to show; the
  // configured order below decides what actually appears.
  const rendered: Record<SidebarBlock, React.ReactNode> = {
    about: (
      <div className={block}>
        <div className="flex items-center gap-3 mb-3">
          <Image
            src={avatarPath}
            alt={authorName}
            width={48}
            height={48}
            className="rounded-full object-cover shrink-0"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-content truncate">{authorName}</p>
            {authorTagline && <p className="text-xs text-content-faint truncate">{authorTagline}</p>}
          </div>
        </div>
        {authorBio && <p className="text-xs text-content-subtle leading-relaxed">{authorBio}</p>}
      </div>
    ),

    recent: recentPosts.length > 0 ? (
      <div className={block}>
        <h2 className={heading}>Recent</h2>
        <ul className="flex flex-col gap-2.5">
          {recentPosts.map((p) => (
            <li key={p.slug}>
              <Link href={`/post/${p.slug}`} className="block group">
                <span className="text-xs text-content-muted group-hover:text-accent-400 transition-colors line-clamp-2">
                  {p.title || "Untitled"}
                </span>
                <span className="block text-[11px] text-content-dim mt-0.5">
                  {new Date(p.publishedAt).toLocaleDateString(undefined, {
                    year: "numeric", month: "short", day: "numeric",
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    ) : null,

    sections: navLinks.length > 0 ? (
      <div className={block}>
        <h2 className={heading}>Sections</h2>
        <ul className="flex flex-col gap-2">
          {navLinks.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="text-xs text-content-subtle hover:text-accent-400 transition-colors">
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    ) : null,

    connect: (
      <div className={block}>
        <h2 className={heading}>Connect</h2>
        <p className="text-xs text-content-faint font-mono break-all mb-2">{fediAddress}</p>
        <div className="flex flex-col gap-2">
          <a href="/feed.xml" className="text-xs text-content-subtle hover:text-accent-400 transition-colors">RSS feed</a>
          {contactEmail && (
            <a href={`mailto:${contactEmail}`} className="text-xs text-content-subtle hover:text-accent-400 transition-colors">
              Email
            </a>
          )}
          {footer.webringUrl && (
            <a href={footer.webringUrl} className="text-xs text-content-subtle hover:text-accent-400 transition-colors">
              {footer.webringLabel}
            </a>
          )}
          {footer.fundingUrl && (
            <a
              href={footer.fundingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-content-subtle hover:text-accent-400 transition-colors"
            >
              ♥ {footer.fundingLabel}
            </a>
          )}
        </div>
      </div>
    ),
  };

  return (
    <aside className="flex flex-col gap-6">
      {blocks.map((name) => {
        const node = rendered[name];
        return node ? <div key={name} className="contents">{node}</div> : null;
      })}
    </aside>
  );
}
