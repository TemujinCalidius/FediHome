import { getSiteStats } from "@/lib/tinylytics";
import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "@/lib/site-profile";
import { getRuntimeSiteConfig } from "@/lib/site-settings";

export default async function Footer() {
  const stats = await getSiteStats();
  const profile = await getRuntimeProfile();
  const site = await getRuntimeSiteConfig();
  const { webringUrl, webringLabel, badgeSrc, badgeHref, badgeAlt, fundingUrl, fundingLabel } =
    site.footer;
  const hasExtras = Boolean(badgeSrc || webringUrl || fundingUrl);

  return (
    <footer className="mt-auto">
      <div className="divider" />
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="text-center md:text-left">
            <p className="text-sm text-content-faint">
              &copy; {new Date().getFullYear()} {profile.authorName}
            </p>
            <p className="text-xs text-content-dim mt-1">
              Self-owned. Self-hosted. Fediverse-native.
            </p>
            {stats && (
              <p className="text-xs text-content-ghost mt-1 font-mono">
                {stats.totalHits.toLocaleString()} visits
                {stats.totalKudos > 0 && ` · ${stats.totalKudos} kudos`}
              </p>
            )}
          </div>

          {/* Center: optional badge + webring — only when configured */}
          {hasExtras && (
            <div className="flex items-center gap-4">
              {badgeSrc &&
                (badgeHref ? (
                  <a
                    href={badgeHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="opacity-70 hover:opacity-100 transition-opacity"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={badgeSrc} alt={badgeAlt} width={100} height={32} />
                  </a>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={badgeSrc}
                    alt={badgeAlt}
                    width={100}
                    height={32}
                    className="opacity-70"
                  />
                ))}
              {webringUrl && (
                <a
                  href={webringUrl}
                  className="text-sm text-content-subtle hover:text-accent-400 transition-colors"
                >
                  {webringLabel}
                </a>
              )}
              {fundingUrl && (
                <a
                  href={fundingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-content-subtle hover:text-accent-400 transition-colors"
                >
                  ♥ {fundingLabel}
                </a>
              )}
            </div>
          )}

          {/* Right: handle + links */}
          <div className="flex items-center gap-5 text-content-faint">
            <span className="text-xs text-content-dim font-mono">
              {siteConfig.fediAddress}
            </span>

            <a
              href="/feed.xml"
              className="hover:text-accent-400 transition-colors"
              title="RSS Feed"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6.18 15.64a2.18 2.18 0 010 4.36 2.18 2.18 0 010-4.36M4 4.44A15.56 15.56 0 0119.56 20h-2.83A12.73 12.73 0 004 7.27V4.44m0 5.66a9.9 9.9 0 019.9 9.9h-2.83A7.07 7.07 0 004 12.93V10.1z" />
              </svg>
            </a>

            {siteConfig.contactEmail && (
              <a
                href={`mailto:${siteConfig.contactEmail}`}
                className="hover:text-accent-400 transition-colors"
                title="Email"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
              </a>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}
