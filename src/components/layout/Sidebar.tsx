import Link from "next/link";
import Image from "next/image";
import { getSidebarData } from "./sidebarData";

/**
 * The sidebar column (#250) — rendered beside the page content when the owner
 * picks the `sidebar` shell variant. Four blocks: about/bio, recent posts,
 * sections, and connect (handle + links). Styled with the existing
 * `glass-card` idiom so it inherits the active theme's surface + feel tokens.
 *
 * No tags block yet: there is no public tag route, so those links would go
 * nowhere. It lands with a public `/tags/[tag]` page in a later slice.
 */
export default async function Sidebar() {
  const {
    authorName, authorBio, authorTagline, avatarPath,
    navLinks, recentPosts, fediAddress, contactEmail, footer,
  } = await getSidebarData();

  const block = "glass-card p-5 h-fit";
  const heading = "text-xs font-semibold text-white uppercase tracking-wider mb-3";

  return (
    <aside className="flex flex-col gap-6">
      {/* About */}
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
            <p className="text-sm font-semibold text-white truncate">{authorName}</p>
            {authorTagline && <p className="text-xs text-gray-500 truncate">{authorTagline}</p>}
          </div>
        </div>
        {authorBio && <p className="text-xs text-gray-400 leading-relaxed">{authorBio}</p>}
      </div>

      {/* Recent posts */}
      {recentPosts.length > 0 && (
        <div className={block}>
          <h2 className={heading}>Recent</h2>
          <ul className="flex flex-col gap-2.5">
            {recentPosts.map((p) => (
              <li key={p.slug}>
                <Link href={`/post/${p.slug}`} className="block group">
                  <span className="text-xs text-gray-300 group-hover:text-accent-400 transition-colors line-clamp-2">
                    {p.title || "Untitled"}
                  </span>
                  <span className="block text-[11px] text-gray-600 mt-0.5">
                    {new Date(p.publishedAt).toLocaleDateString(undefined, {
                      year: "numeric", month: "short", day: "numeric",
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sections */}
      {navLinks.length > 0 && (
        <div className={block}>
          <h2 className={heading}>Sections</h2>
          <ul className="flex flex-col gap-2">
            {navLinks.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-xs text-gray-400 hover:text-accent-400 transition-colors">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Connect */}
      <div className={block}>
        <h2 className={heading}>Connect</h2>
        <p className="text-xs text-gray-500 font-mono break-all mb-2">{fediAddress}</p>
        <div className="flex flex-col gap-2">
          <a href="/feed.xml" className="text-xs text-gray-400 hover:text-accent-400 transition-colors">RSS feed</a>
          {contactEmail && (
            <a href={`mailto:${contactEmail}`} className="text-xs text-gray-400 hover:text-accent-400 transition-colors">
              Email
            </a>
          )}
          {footer.webringUrl && (
            <a href={footer.webringUrl} className="text-xs text-gray-400 hover:text-accent-400 transition-colors">
              {footer.webringLabel}
            </a>
          )}
          {footer.fundingUrl && (
            <a
              href={footer.fundingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-400 hover:text-accent-400 transition-colors"
            >
              ♥ {footer.fundingLabel}
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}
