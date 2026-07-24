import Link from "next/link";
import Image from "next/image";
import { siteConfig } from "@/../site.config";
import type { RuntimeSiteConfig } from "@/lib/site-settings";

// What FediHome does — shown on the project showcase landing (LANDING_MODE=true).
// Benefit-led and plain-language on purpose; the technical terms people search
// for (ActivityPub, fediverse, RSS…) live in the "Open by design" section below,
// where they inform without gatekeeping.
const FEATURES = [
  {
    title: "Own everything you post",
    body: "Your words, photos, videos and audio live on your own domain — not on a platform that can change the rules, run ads against them, or lock you out.",
  },
  {
    title: "Followable from anywhere",
    body: "People follow you from wherever they already are, and your posts land in their feed. Like email, it just works across different services — no account on your site needed.",
  },
  {
    title: "Your own feed",
    body: "Follow the people and creators you like and read them in one timeline on your own site — in the order they posted, never rearranged by an algorithm.",
  },
  {
    title: "One home for everything",
    body: "Quick thoughts, long articles with titles, a photo gallery, videos, and a podcast-style audio feed — every format, all first-class.",
  },
  {
    title: "Post from anywhere",
    body: "Write from the web or the Mac app, publish from your phone, and let anyone subscribe by RSS or install your site like an app.",
  },
  {
    title: "Free, and truly yours",
    body: "Open source and self-hosted. Run it yourself and update with a single command that never touches your data.",
  },
];

const INSTALL_ONE_LINER =
  "curl -sSL https://raw.githubusercontent.com/TemujinCalidius/fedihome/main/install.sh | bash";

/**
 * Project showcase landing for the homepage, shown when LANDING_MODE=true.
 * Explains what FediHome is, that it's open source + AI-written, and how to
 * get it. Powers the public demo at fedihome.social; off by default so a
 * personal instance keeps its normal homepage.
 */
export default function LandingShowcase({
  landing,
  footer,
  download,
}: {
  landing: RuntimeSiteConfig["landing"];
  footer: RuntimeSiteConfig["footer"];
  download: RuntimeSiteConfig["download"];
}) {
  const repo = landing.repoUrl;
  const funding = footer.fundingUrl;
  const showMacApp = download.macosEnabled;
  return (
    <div className="relative overflow-hidden">
      {/* Subtle generated texture backdrop + fade into the page background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage: "url(/landing/texture.webp)",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-surface-950/30 via-surface-950/60 to-surface-950"
      />

      <div className="relative max-w-5xl mx-auto px-6 pt-16 pb-12 md:pt-24">
        {/* ── Hero ───────────────────────────────────────────── */}
        <section className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-accent-500/30 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-accent-400">
              Open source · Self-hosted · No lock-in
            </span>
            <h1 className="mt-5 font-display text-4xl md:text-5xl font-bold leading-tight text-white">
              {landing.headline}
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-gray-400">
              {landing.subhead}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {/* When the macOS app is enabled it becomes the hero's primary
                  action; "View on GitHub" then steps down to the outlined style
                  so there's exactly one filled button. */}
              {showMacApp && (
                <Link href="/download" className="btn-primary text-xs">
                  Download for Mac
                </Link>
              )}
              <a
                href={repo}
                target="_blank"
                rel="noopener noreferrer"
                className={showMacApp ? "btn-outlined text-xs" : "btn-primary text-xs"}
              >
                View on GitHub
              </a>
              <a href="#install" className="btn-outlined text-xs">
                How to install
              </a>
              {funding && (
                <a
                  href={funding}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-outlined text-xs"
                >
                  ♥ {footer.fundingLabel}
                </a>
              )}
            </div>
            <p className="mt-4 text-sm text-gray-500">
              This whole site is a FediHome. Follow{" "}
              <span className="text-accent-400">{siteConfig.fediAddress}</span>{" "}
              and watch it show up in your feed.
            </p>
          </div>

          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-6 rounded-full bg-accent-500/10 blur-3xl"
            />
            <Image
              src="/landing/hero.webp"
              alt="A glowing home at the heart of the open web"
              width={1024}
              height={1024}
              priority
              className="relative w-full h-auto rounded-2xl"
            />
          </div>
        </section>

        {/* ── What it does ───────────────────────────────────── */}
        <section className="mt-24">
          <h2 className="font-display text-2xl md:text-3xl font-semibold text-white">
            What FediHome does
          </h2>
          <p className="mt-2 max-w-2xl text-gray-400">
            A complete personal site — your posts, your photos and media, and a
            feed of the people you follow — all on a domain that&apos;s yours.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="glass-card p-5">
                <h3 className="font-display text-base font-semibold text-white">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-400">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Open by design ─────────────────────────────────────
            The one section that names the technical standards. It's the
            no-lock-in proof AND the SEO home for the terms people search
            (ActivityPub, WebFinger, RSS, Mastodon, fediverse, self-hosted) —
            deliberately below the fold so it informs without gatekeeping. */}
        <section className="mt-20 glass-card p-8 md:p-10">
          <h2 className="font-display text-2xl md:text-3xl font-semibold text-white">
            Open by design — no lock-in, ever
          </h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-gray-400">
            FediHome is free and open source (MIT-licensed) and built on the
            open standards of the social web — <span className="text-gray-300">ActivityPub</span>,
            WebFinger and RSS. That&apos;s the same network Mastodon and
            thousands of other independent sites already share, often called the{" "}
            <span className="text-gray-300">fediverse</span>. It&apos;s why
            people can follow you from anywhere, why you&apos;re never tied to
            one company, and why — if you ever move — your followers can come
            with you. Read the code, fork it, or run your own.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={repo}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary text-xs"
            >
              View the source
            </a>
            <a
              href={`${repo}/blob/main/LICENSE`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-outlined text-xs"
            >
              MIT License
            </a>
          </div>
        </section>

        {/* ── How to install ─────────────────────────────────── */}
        <section id="install" className="mt-20 scroll-mt-20">
          <h2 className="font-display text-2xl md:text-3xl font-semibold text-white">
            Run your own in minutes
          </h2>
          <p className="mt-2 max-w-2xl text-gray-400">
            On a Mac, Linux box, or home server with Node.js and PostgreSQL.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="glass-card p-6">
              <h3 className="font-display text-base font-semibold text-white">
                One command
              </h3>
              <p className="mt-2 text-sm text-gray-400">
                The installer pulls FediHome, sets up the database, and walks you
                through setup:
              </p>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-surface-700 bg-surface-950/80 p-3 text-xs leading-relaxed text-accent-300">
                <code>{INSTALL_ONE_LINER}</code>
              </pre>
            </div>
            <div className="glass-card p-6">
              <h3 className="font-display text-base font-semibold text-white">
                Install with AI
              </h3>
              <p className="mt-2 text-sm text-gray-400">
                Never used a terminal? Let an AI assistant drive the whole
                install for you, step by step.
              </p>
              <a
                href={`${repo}/blob/main/docs/install-with-ai.md`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-outlined mt-4 text-xs"
              >
                Read the guide
              </a>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={repo}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary text-xs"
            >
              Get FediHome
            </a>
            <a
              href={`${repo}/tree/main/docs`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-outlined text-xs"
            >
              Documentation
            </a>
            <Link href="/about" className="btn-outlined text-xs">
              About this instance
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
