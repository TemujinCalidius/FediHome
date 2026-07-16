"use client";

import { useState } from "react";
import Link from "next/link";
import type { RuntimeSiteConfig } from "@/lib/site-settings";

/**
 * Site settings (#59): the safe appearance/feature config, editable in-app.
 * Saves write `SiteSetting` overrides via /api/admin/site-config; the site
 * re-reads within a minute (60s cache), no restart. "Use env defaults" clears
 * every override.
 */
export default function SiteSettingsClient({
  defaults,
  effective,
  overrides,
}: {
  defaults: RuntimeSiteConfig;
  effective: RuntimeSiteConfig;
  overrides: Record<string, string>;
}) {
  const [cfg, setCfg] = useState<RuntimeSiteConfig>(effective);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [hasOverrides, setHasOverrides] = useState(Object.keys(overrides).length > 0);

  async function post(settings: Record<string, string | null>): Promise<boolean> {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/site-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, msg: data.error || "Save failed" });
        return false;
      }
      setCfg(data.effective as RuntimeSiteConfig);
      setResult({ ok: true, msg: "Saved — changes apply across your site within a minute." });
      return true;
    } catch {
      setResult({ ok: false, msg: "Save failed" });
      return false;
    } finally {
      setSaving(false);
    }
  }

  const save = async () => {
    const settings: Record<string, string> = {
      "site.name": cfg.name,
      "site.description": cfg.description,
      "landing.mode": String(cfg.landing.mode),
      "landing.headline": cfg.landing.headline,
      "landing.subhead": cfg.landing.subhead,
      "landing.repoUrl": cfg.landing.repoUrl,
      "feed.public": String(cfg.publicFeed),
      "feed.publicTitle": cfg.publicFeedTitle,
      "feed.hideSocialGraph": String(cfg.hideSocialGraph),
      "nav.journal": String(cfg.nav.showJournal),
      "nav.articles": String(cfg.nav.showArticles),
      "nav.photography": String(cfg.nav.showPhotography),
      "nav.videos": String(cfg.nav.showVideos),
      "nav.audio": String(cfg.nav.showAudio),
      "nav.about": String(cfg.nav.showAbout),
      "footer.webringUrl": cfg.footer.webringUrl,
      "footer.webringLabel": cfg.footer.webringLabel,
      "footer.badgeSrc": cfg.footer.badgeSrc,
      "footer.badgeHref": cfg.footer.badgeHref,
      "footer.badgeAlt": cfg.footer.badgeAlt,
      "footer.fundingUrl": cfg.footer.fundingUrl,
      "footer.fundingLabel": cfg.footer.fundingLabel,
      "download.macos.enabled": String(cfg.download.macosEnabled),
      "download.macos.releaseUrl": cfg.download.macosReleaseUrl,
      "download.macos.appStoreUrl": cfg.download.macosAppStoreUrl,
      "layout.feed": cfg.layout.feed || "cards",
    };
    if (await post(settings)) setHasOverrides(true);
  };

  const useDefaults = async () => {
    const cleared = Object.fromEntries(
      [
        "site.name", "site.description", "landing.mode", "landing.headline", "landing.subhead",
        "landing.repoUrl", "feed.public", "feed.publicTitle", "feed.hideSocialGraph",
        "nav.journal", "nav.articles", "nav.photography", "nav.videos", "nav.audio", "nav.about",
        "footer.webringUrl", "footer.webringLabel", "footer.badgeSrc", "footer.badgeHref",
        "footer.badgeAlt", "footer.fundingUrl", "footer.fundingLabel",
        "download.macos.enabled", "download.macos.releaseUrl", "download.macos.appStoreUrl",
        "layout.feed",
      ].map((k) => [k, null]),
    );
    if (await post(cleared)) {
      setCfg(defaults);
      setHasOverrides(false);
    }
  };

  const set = (patch: Partial<RuntimeSiteConfig>) => setCfg((c) => ({ ...c, ...patch }));
  const setNav = (patch: Partial<RuntimeSiteConfig["nav"]>) => setCfg((c) => ({ ...c, nav: { ...c.nav, ...patch } }));
  const setLanding = (patch: Partial<RuntimeSiteConfig["landing"]>) => setCfg((c) => ({ ...c, landing: { ...c.landing, ...patch } }));
  const setFooter = (patch: Partial<RuntimeSiteConfig["footer"]>) => setCfg((c) => ({ ...c, footer: { ...c.footer, ...patch } }));
  const setDownload = (patch: Partial<RuntimeSiteConfig["download"]>) => setCfg((c) => ({ ...c, download: { ...c.download, ...patch } }));
  const setLayout = (patch: Partial<RuntimeSiteConfig["layout"]>) => setCfg((c) => ({ ...c, layout: { ...c.layout, ...patch } }));

  const text = (label: string, value: string, onChange: (v: string) => void, placeholder = "") => (
    <label className="flex flex-col gap-1 text-xs text-gray-400">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
      />
    </label>
  );
  const select = (
    label: string,
    value: string,
    options: { value: string; label: string }[],
    onChange: (v: string) => void,
    hint?: string,
  ) => (
    <label className="flex flex-col gap-1 text-xs text-gray-400">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {hint && <span className="text-gray-600">{hint}</span>}
    </label>
  );
  const check = (label: string, value: boolean, onChange: (v: boolean) => void) => (
    <label className="flex items-center gap-2 text-sm text-white">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
  const section = (title: string, children: React.ReactNode) => (
    <section className="py-4 border-b border-surface-800 last:border-b-0">
      <h2 className="text-sm font-semibold text-white mb-3">{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );

  return (
    <main className="max-w-2xl mx-auto px-4 py-10">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Site settings</h1>
        <Link href="/timeline" className="text-xs text-gray-400 hover:text-white underline">← Timeline</Link>
      </div>

      <div className="rounded-lg border border-surface-700 bg-surface-900 px-5">
        <div className="flex items-baseline justify-between pt-4">
          <p className="text-xs text-gray-500 m-0">Appearance &amp; features — applies to your public site, no restart.</p>
          <span className="text-xs text-gray-500">{hasOverrides ? "using saved overrides" : "using env defaults"}</span>
        </div>

        {section("Identity", <>
          {text("Site name", cfg.name, (v) => set({ name: v }))}
          {text("Description", cfg.description, (v) => set({ description: v }))}
          <p className="text-xs text-gray-600 m-0">Your Fediverse handle and domain are set at install and can&apos;t change here — they&apos;re part of your federated identity.</p>
        </>)}

        {section("Appearance", <>
          {select(
            "Feed layout",
            cfg.layout.feed === "list" ? "list" : "cards",
            [
              { value: "cards", label: "Cards — glass cards with cover images" },
              { value: "list", label: "List — compact, date-led index" },
            ],
            (v) => setLayout({ feed: v }),
            "How your posts appear on the homepage and blog.",
          )}
        </>)}

        {section("Landing page", <>
          {check("Show the project-style landing page on the homepage", cfg.landing.mode, (v) => setLanding({ mode: v }))}
          {text("Headline", cfg.landing.headline, (v) => setLanding({ headline: v }))}
          {text("Subhead", cfg.landing.subhead, (v) => setLanding({ subhead: v }))}
          {text("Repo URL", cfg.landing.repoUrl, (v) => setLanding({ repoUrl: v }))}
        </>)}

        {section("Public Fediverse feed", <>
          {check("Show a login-free read-only feed at /fediverse", cfg.publicFeed, (v) => set({ publicFeed: v }))}
          {text("Feed title", cfg.publicFeedTitle, (v) => set({ publicFeedTitle: v }))}
          {check("Hide follower/following lists (report counts only)", cfg.hideSocialGraph, (v) => set({ hideSocialGraph: v }))}
        </>)}

        {section("Navigation", <div className="grid grid-cols-2 gap-2">
          {check("Journal", cfg.nav.showJournal, (v) => setNav({ showJournal: v }))}
          {check("Articles", cfg.nav.showArticles, (v) => setNav({ showArticles: v }))}
          {check("Photography", cfg.nav.showPhotography, (v) => setNav({ showPhotography: v }))}
          {check("Videos", cfg.nav.showVideos, (v) => setNav({ showVideos: v }))}
          {check("Audio", cfg.nav.showAudio, (v) => setNav({ showAudio: v }))}
          {check("About", cfg.nav.showAbout, (v) => setNav({ showAbout: v }))}
        </div>)}

        {section("Footer", <>
          {text("Webring URL", cfg.footer.webringUrl, (v) => setFooter({ webringUrl: v }), "https://…")}
          {text("Webring label", cfg.footer.webringLabel, (v) => setFooter({ webringLabel: v }))}
          {text("Badge image URL", cfg.footer.badgeSrc, (v) => setFooter({ badgeSrc: v }), "https://…")}
          {text("Badge link URL", cfg.footer.badgeHref, (v) => setFooter({ badgeHref: v }), "https://…")}
          {text("Badge alt text", cfg.footer.badgeAlt, (v) => setFooter({ badgeAlt: v }))}
          {text("Funding URL", cfg.footer.fundingUrl, (v) => setFooter({ fundingUrl: v }), "https://…")}
          {text("Funding label", cfg.footer.fundingLabel, (v) => setFooter({ fundingLabel: v }))}
        </>)}

        {section("macOS app", <>
          {check("Show the Download nav link, homepage CTA & /download page", cfg.download.macosEnabled, (v) => setDownload({ macosEnabled: v }))}
          {text("Release URL (GitHub Releases)", cfg.download.macosReleaseUrl, (v) => setDownload({ macosReleaseUrl: v }), "https://…")}
          {text("Mac App Store URL (optional)", cfg.download.macosAppStoreUrl, (v) => setDownload({ macosAppStoreUrl: v }), "https://…")}
        </>)}

        <div className="flex items-center gap-3 py-4">
          <button onClick={save} disabled={saving} className="btn-primary disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={useDefaults}
            disabled={saving || !hasOverrides}
            className="text-xs text-gray-400 hover:text-white underline disabled:opacity-40 disabled:no-underline"
          >
            Use env defaults
          </button>
        </div>
      </div>

      {result && <p className={`mt-4 text-sm ${result.ok ? "text-green-400" : "text-red-400"}`}>{result.msg}</p>}
    </main>
  );
}
