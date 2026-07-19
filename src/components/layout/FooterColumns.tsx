import Link from "next/link";
import { getFooterData } from "./footerData";
import { RssIcon } from "./headerData";

/**
 * Footer variant: "columns" (#250). A sitemap footer — your sections, connect
 * links, and credit laid out in columns, with the optional badge / webring /
 * funding extras folded in. Suits content-heavy sites where the footer doubles
 * as navigation. Keeps `mt-auto` so short pages still push it to the bottom.
 */
export default async function FooterColumns() {
  const { stats, authorName, siteName, footer, navLinks, fediAddress, contactEmail, year } =
    await getFooterData();
  const { webringUrl, webringLabel, badgeSrc, badgeHref, badgeAlt, fundingUrl, fundingLabel } = footer;
  const hasExtras = Boolean(badgeSrc || webringUrl || fundingUrl);

  return (
    <footer className="mt-auto">
      <div className="divider" />
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          {/* About */}
          <div>
            <h2 className="text-sm font-semibold text-white mb-2">{siteName}</h2>
            <p className="text-xs text-gray-600">Self-owned. Self-hosted. Fediverse-native.</p>
            {stats && (
              <p className="text-xs text-gray-700 mt-2 font-mono">
                {stats.totalHits.toLocaleString()} visits
                {stats.totalKudos > 0 && ` · ${stats.totalKudos} kudos`}
              </p>
            )}
          </div>

          {/* Sections */}
          {navLinks.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-white mb-2">Sections</h2>
              <ul className="flex flex-col gap-1.5">
                {navLinks.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-xs text-gray-500 hover:text-accent-400 transition-colors">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Connect */}
          <div>
            <h2 className="text-sm font-semibold text-white mb-2">Connect</h2>
            <p className="text-xs text-gray-600 font-mono mb-2">{fediAddress}</p>
            <div className="flex items-center gap-4 text-gray-500">
              <a href="/feed.xml" className="hover:text-accent-400 transition-colors" title="RSS Feed">
                <RssIcon />
              </a>
              {contactEmail && (
                <a href={`mailto:${contactEmail}`} className="text-xs hover:text-accent-400 transition-colors">
                  Email
                </a>
              )}
              {webringUrl && (
                <a href={webringUrl} className="text-xs hover:text-accent-400 transition-colors">
                  {webringLabel}
                </a>
              )}
              {fundingUrl && (
                <a
                  href={fundingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs hover:text-accent-400 transition-colors"
                >
                  ♥ {fundingLabel}
                </a>
              )}
            </div>
            {hasExtras && badgeSrc && (
              <div className="mt-3">
                {badgeHref ? (
                  <a href={badgeHref} target="_blank" rel="noopener noreferrer" className="opacity-70 hover:opacity-100 transition-opacity">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={badgeSrc} alt={badgeAlt} width={100} height={32} />
                  </a>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={badgeSrc} alt={badgeAlt} width={100} height={32} className="opacity-70" />
                )}
              </div>
            )}
          </div>
        </div>

        <p className="text-xs text-gray-600 mt-8 pt-6 border-t border-surface-800">
          &copy; {year} {authorName}
        </p>
      </div>
    </footer>
  );
}
