import Link from "next/link";
import Image from "next/image";
import { siteConfig } from "@/../site.config";

// What FediHome does — shown on the project showcase landing (LANDING_MODE=true).
const FEATURES = [
  {
    title: "Own your content",
    body: "Your posts, photos, videos and audio live on your own domain — not on a platform that can change the rules.",
  },
  {
    title: "Federated by default",
    body: "FediHome speaks ActivityPub, so anyone on Mastodon and the wider Fediverse can follow, reply and boost.",
  },
  {
    title: "A real feed",
    body: "Follow people across the Fediverse and read them in a timeline that lives on your own site.",
  },
  {
    title: "Blog + media built in",
    body: "Articles, journal notes, a photography gallery, and video and audio sections — all first-class.",
  },
  {
    title: "Yours to run, free forever",
    body: "MIT-licensed and self-hosted. Update with a single command that never touches your data.",
  },
  {
    title: "IndieWeb friendly",
    body: "Micropub publishing, RSS, WebFinger and installable PWA support work out of the box.",
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
export default function LandingShowcase() {
  const repo = siteConfig.repoUrl;
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
              Open source · Fediverse · Self-hosted
            </span>
            <h1 className="mt-5 font-display text-4xl md:text-5xl font-bold leading-tight text-white">
              {siteConfig.landingHeadline}
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-gray-400">
              {siteConfig.landingSubhead}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href={repo}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary text-xs"
              >
                View on GitHub
              </a>
              <a href="#install" className="btn-outlined text-xs">
                How to install
              </a>
            </div>
            <p className="mt-4 text-sm text-gray-500">
              Follow{" "}
              <span className="text-accent-400">{siteConfig.fediAddress}</span>{" "}
              on the Fediverse.
            </p>
          </div>

          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-6 rounded-full bg-accent-500/10 blur-3xl"
            />
            <Image
              src="/landing/hero.webp"
              alt="A glowing home connected to a network of Fediverse nodes"
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
            A complete personal site that speaks the language of the Fediverse —
            blog, media, and a live feed, all on a domain you control.
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

        {/* ── Open source & AI-written ───────────────────────── */}
        <section className="mt-20 glass-card p-8 md:p-10">
          <h2 className="font-display text-2xl md:text-3xl font-semibold text-white">
            Completely open source. Written by AI.
          </h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-gray-400">
            FediHome is MIT-licensed and built end-to-end with Claude Code —
            every line is public on GitHub. Read it, fork it, run it, and shape
            it. No accounts, no lock-in, no cost.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={repo}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary text-xs"
            >
              Star it on GitHub
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
