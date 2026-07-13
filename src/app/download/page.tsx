import Link from "next/link";
import { notFound } from "next/navigation";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import MacAppMockup from "@/components/download/MacAppMockup";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Download for Mac",
  description:
    "A native menu-bar Mac app for your FediHome — read your feed, post with photos, video and audio, manage your profile, DMs and notifications. Requires macOS 14 or later, notarized by Apple.",
};

// The app's headline capabilities — kept generic/marketing (no instance config).
const FEATURES = [
  {
    title: "Your whole feed",
    body: "Read everyone you follow across the Fediverse in a fast, native timeline — like, boost and reply in a click.",
  },
  {
    title: "Compose anything",
    body: "Write posts with photos, video and audio, schedule them for later, and save drafts — right from your Mac.",
  },
  {
    title: "Manage your site",
    body: "Edit your profile and manage or delete your posts without ever opening a browser tab.",
  },
  {
    title: "Direct messages",
    body: "Read and send DMs from the menu bar, wherever the conversation is happening.",
  },
  {
    title: "Native notifications",
    body: "Get real macOS notifications for replies, follows, boosts and mentions as they land.",
  },
  {
    title: "Lives in your menu bar",
    body: "Always one click away in the corner of your screen — never a tab you lose.",
  },
];

function DownloadGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
      <path d="M8 1.5 v8" strokeLinecap="round" />
      <path d="M4.5 6.5 L8 10 l3.5 -3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 13.5 h11" strokeLinecap="round" />
    </svg>
  );
}

export default async function DownloadPage() {
  const site = await getRuntimeSiteConfig();
  const { macosEnabled, macosReleaseUrl, macosAppStoreUrl } = site.download;
  // An admin can clear the release URL (empty is a valid url value); never
  // render a download button that points at "" (it would just reload the page).
  const hasRelease = macosReleaseUrl.length > 0;

  // Section is a deliberate marketing surface, off unless enabled. When it's
  // off the page shouldn't exist at all (and the nav link is already hidden).
  if (!macosEnabled) notFound();

  return (
    <div className="max-w-5xl mx-auto px-6 py-16">
      {/* ── Hero ── */}
      <section className="grid items-center gap-10 lg:grid-cols-2">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-accent-500/30 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-accent-400">
            Native macOS app
          </span>
          <h1 className="mt-5 font-display text-4xl md:text-5xl font-bold leading-tight text-white">
            {site.name} for Mac
          </h1>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-gray-400">
            A native menu-bar app for your FediHome. Read your feed, post with photos, video and
            audio, schedule and draft, manage your profile and posts, send DMs, and get native
            notifications — without opening a browser.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            {hasRelease && (
              <a
                href={macosReleaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary text-xs"
              >
                <DownloadGlyph />
                Download for macOS
              </a>
            )}

            {/* Mac App Store slot — the official badge + link drops in here once
                the listing is approved (set DOWNLOAD_MACOS_APP_STORE_URL). */}
            {macosAppStoreUrl ? (
              <a
                href={macosAppStoreUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-outlined text-xs"
              >
                Download on the Mac App Store
              </a>
            ) : (
              <span className="inline-flex items-center rounded-lg border border-dashed border-surface-600 px-4 py-2 text-xs text-gray-500">
                Mac App Store — coming soon
              </span>
            )}
          </div>

          <ul className="mt-6 space-y-2 text-sm text-gray-400">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-accent-400" aria-hidden>✓</span>
              <span>Requires <strong className="text-gray-300">macOS 14 (Sonoma)</strong> or later.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-accent-400" aria-hidden>✓</span>
              <span><strong className="text-gray-300">Notarized by Apple</strong> — double-click to open, no scary warnings.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-accent-400" aria-hidden>✓</span>
              <span>Free, and always the newest build — straight from GitHub Releases.</span>
            </li>
          </ul>
        </div>

        <div className="relative">
          <div aria-hidden className="absolute -inset-6 rounded-full bg-accent-500/10 blur-3xl" />
          <MacAppMockup className="relative w-full h-auto" />
        </div>
      </section>

      {/* ── What the app does ── */}
      <section className="mt-20">
        <h2 className="font-display text-2xl md:text-3xl font-semibold text-white">
          Your FediHome, native on the Mac
        </h2>
        <p className="mt-2 max-w-2xl text-gray-400">
          Everything you do on your site, in a fast app that lives in your menu bar.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="glass-card p-5">
              <h3 className="font-display text-base font-semibold text-white">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-400">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Get it / iOS note ── */}
      <section className="mt-16 glass-card p-8 md:p-10">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div>
            <h2 className="font-display text-xl md:text-2xl font-semibold text-white">
              Get the Mac app
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-400">
              {hasRelease
                ? "Download the latest notarized build below. iPhone and iPad apps are coming next."
                : "The download will be available here shortly. iPhone and iPad apps are coming next."}
            </p>
          </div>
          {hasRelease && (
            <a
              href={macosReleaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary text-xs"
            >
              <DownloadGlyph />
              Download for macOS
            </a>
          )}
        </div>
      </section>

      <p className="mt-8 text-center text-sm text-gray-500">
        Prefer the web?{" "}
        <Link href="/" className="text-accent-400 hover:text-accent-300">
          Back to {site.name}
        </Link>
        .
      </p>
    </div>
  );
}
