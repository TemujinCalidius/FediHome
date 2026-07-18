"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { RuntimeSiteConfig } from "@/lib/site-settings";
// Pure data + math (no prisma / server-only), so it's safe in a client bundle.
import { THEMES, DEFAULT_ACCENT } from "@/lib/themes";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Site settings (#59): the safe appearance/feature config, editable in-app.
 * Saves write `SiteSetting` overrides via /api/admin/site-config; the site
 * re-reads within a minute (60s cache), no restart. "Use env defaults" clears
 * every override.
 *
 * The accent colour (#276) is the exception: it lives in the profile overlay,
 * so its control POSTs to /api/admin `update_profile` (single source of truth
 * with /api/account + the AP actor), even though it renders here in Appearance.
 * Accent is PER-THEME — each theme remembers its own, and "inherit" uses the
 * theme's built-in accent.
 */
export default function SiteSettingsClient({
  defaults,
  effective,
  overrides,
  accent,
}: {
  defaults: RuntimeSiteConfig;
  effective: RuntimeSiteConfig;
  overrides: Record<string, string>;
  accent: { accentColor: string; themeAccents: Record<string, string> };
}) {
  const [cfg, setCfg] = useState<RuntimeSiteConfig>(effective);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [hasOverrides, setHasOverrides] = useState(Object.keys(overrides).length > 0);

  // Per-theme accent (#276). Mirrors the server's resolveAccent; the accent
  // editor below is bound to the currently-selected theme (cfg.theme.id).
  const [themeAccents, setThemeAccents] = useState<Record<string, string>>(accent.themeAccents);
  const [legacyAccent, setLegacyAccent] = useState<string>(accent.accentColor); // default theme's legacy accent
  const themeOwnAccent = (id: string): string => THEMES[id]?.tokens.colors["accent-500"] ?? DEFAULT_ACCENT;
  /** The stored accent for a theme, or null = inherit (mirrors themes/resolveAccent). */
  const storedAccent = (id: string): string | null => {
    const per = themeAccents[id];
    if (per && HEX_RE.test(per)) return per;
    if (id === "default" && legacyAccent && legacyAccent.toLowerCase() !== DEFAULT_ACCENT.toLowerCase()) return legacyAccent;
    return null;
  };
  const selTheme = cfg.theme.id || "default";
  const [accentInherit, setAccentInherit] = useState<boolean>(storedAccent(selTheme) === null);
  const [accentHex, setAccentHex] = useState<string>(storedAccent(selTheme) ?? themeOwnAccent(selTheme));

  // Re-seed the accent editor when the selected theme changes.
  const selectTheme = (id: string) => {
    setCfg((c) => ({ ...c, theme: { ...c.theme, id } }));
    const s = storedAccent(id);
    setAccentInherit(s === null);
    setAccentHex(s ?? themeOwnAccent(id));
  };

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

  /** Persist the selected theme's accent via update_profile (profile overlay, #276). */
  async function saveAccent(): Promise<boolean> {
    const id = selTheme;
    const desired = accentInherit ? null : accentHex.trim().toLowerCase();
    if (desired !== null && !HEX_RE.test(desired)) {
      setResult({ ok: false, msg: "Accent colour must be a #RRGGBB hex value." });
      return false;
    }
    if (desired === storedAccent(id)) return true; // unchanged → nothing to write
    const body: Record<string, unknown> = {
      action: "update_profile",
      themeAccents: { [id]: desired ?? "" }, // "" clears the entry → inherit the theme's accent
    };
    // Keep the legacy accentColor (what the macOS app reads) in sync for the default theme.
    if (id === "default") body.accentColor = desired ?? DEFAULT_ACCENT;
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setResult({ ok: false, msg: d.error || "Couldn't save the accent colour." });
        return false;
      }
      setThemeAccents((prev) => {
        const next = { ...prev };
        if (desired) next[id] = desired;
        else delete next[id];
        return next;
      });
      if (id === "default") setLegacyAccent(desired ?? DEFAULT_ACCENT);
      return true;
    } catch {
      setResult({ ok: false, msg: "Couldn't save the accent colour." });
      return false;
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
      "theme.id": cfg.theme.id || "default", // "" would fail validation and 400 the whole batch
      // Sent as-is: "" means "inherit the theme's feed variant". Coercing it to
      // "cards" here would pin an override on first save and stop a theme's own
      // preset (e.g. Editorial's list) from ever applying.
      "layout.feed": cfg.layout.feed,
      "contact.email": cfg.contact.email,
      "podcast.title": cfg.podcast.title,
      "podcast.author": cfg.podcast.author,
      "podcast.description": cfg.podcast.description,
      "podcast.email": cfg.podcast.email,
      "podcast.image": cfg.podcast.image,
      "categories.photos": catText.photos,
      "categories.videos": catText.videos,
      "categories.audio": catText.audio,
      "analytics.siteId": cfg.analytics.siteId,
      "analytics.embedId": cfg.analytics.embedId,
    };
    const okConfig = await post(settings);
    const okAccent = await saveAccent(); // separate overlay (profile); no-op if unchanged
    if (okConfig) setHasOverrides(true);
    if (okConfig && !okAccent) {
      // post() set a success message; correct it if the accent write failed.
      setResult({ ok: false, msg: "Settings saved, but the accent colour didn't." });
    }
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
        "theme.id", "layout.feed", "contact.email",
        "podcast.title", "podcast.author", "podcast.description", "podcast.email", "podcast.image",
        "categories.photos", "categories.videos", "categories.audio",
        "analytics.siteId", "analytics.embedId",
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
  const setContact = (patch: Partial<RuntimeSiteConfig["contact"]>) => setCfg((c) => ({ ...c, contact: { ...c.contact, ...patch } }));
  const setPodcast = (patch: Partial<RuntimeSiteConfig["podcast"]>) => setCfg((c) => ({ ...c, podcast: { ...c.podcast, ...patch } }));
  const setAnalytics = (patch: Partial<RuntimeSiteConfig["analytics"]>) => setCfg((c) => ({ ...c, analytics: { ...c.analytics, ...patch } }));

  // Categories (#284) are edited as raw comma-separated TEXT (so typing a comma
  // works), and only split/normalized server-side on save. Held separately from
  // `cfg.categories` (always the resolved slug arrays), and re-seeded from the
  // server's normalized response whenever cfg.categories changes (save / defaults).
  const catCsv = (c: RuntimeSiteConfig) => ({
    photos: c.categories.photos.join(", "),
    videos: c.categories.videos.join(", "),
    audio: c.categories.audio.join(", "),
  });
  const [catText, setCatText] = useState(catCsv(effective));
  useEffect(() => { setCatText(catCsv(cfg)); }, [cfg.categories]); // eslint-disable-line react-hooks/exhaustive-deps

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
            "Theme",
            cfg.theme.id,
            Object.values(THEMES).map((t) => ({ value: t.id, label: `${t.name} — ${t.description ?? ""}` })),
            selectTheme,
            "Colours and typography across your whole site.",
          )}
          {/* Accent colour — per theme (#276). Writes the profile overlay, not site-config. */}
          <div className="flex flex-col gap-1.5 text-xs text-gray-400">
            <span>Accent colour for {THEMES[selTheme]?.name ?? "this theme"}</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="color"
                aria-label="Accent colour"
                value={HEX_RE.test(accentHex) ? accentHex : themeOwnAccent(selTheme)}
                onChange={(e) => { setAccentHex(e.target.value); setAccentInherit(false); }}
                className="h-8 w-10 rounded border border-surface-700 bg-surface-800 p-0.5"
              />
              <input
                type="text"
                value={accentHex}
                placeholder="#3b82f6"
                onChange={(e) => { setAccentHex(e.target.value); setAccentInherit(false); }}
                className="w-28 bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white font-mono"
              />
              {accentInherit ? (
                <span className="text-gray-600">using the theme&apos;s own accent</span>
              ) : (
                <button
                  type="button"
                  onClick={() => { setAccentInherit(true); setAccentHex(themeOwnAccent(selTheme)); }}
                  className="text-gray-400 hover:text-white underline"
                >
                  Use theme&apos;s accent
                </button>
              )}
            </div>
            <span className="text-gray-600">Links, buttons, borders and badges. Each theme remembers its own.</span>
          </div>
          {select(
            "Feed layout",
            cfg.layout.feed,
            [
              { value: "", label: "Inherit from theme" },
              { value: "cards", label: "Cards — glass cards with cover images" },
              { value: "list", label: "List — compact, date-led index" },
            ],
            (v) => setLayout({ feed: v }),
            "How your posts appear on the homepage and blog. Each theme picks a default; override it here.",
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

        {section("Contact & podcast", <>
          {text("Contact email", cfg.contact.email, (v) => setContact({ email: v }), "you@example.com")}
          <p className="text-xs text-gray-600 m-0">Podcast feed for <code>/audio</code>. Leave any field blank to derive it from your profile.</p>
          {text("Podcast title", cfg.podcast.title, (v) => setPodcast({ title: v }), "e.g. Field Notes")}
          {text("Podcast author", cfg.podcast.author, (v) => setPodcast({ author: v }))}
          {text("Podcast description", cfg.podcast.description, (v) => setPodcast({ description: v }))}
          {text("Podcast email", cfg.podcast.email, (v) => setPodcast({ email: v }), "defaults to your contact email")}
          {text("Podcast cover image URL", cfg.podcast.image, (v) => setPodcast({ image: v }), "https://…")}
        </>)}

        {section("Categories", <>
          <p className="text-xs text-gray-600 m-0">
            Gallery categories for photos, videos and audio. Comma-separated, lowercase, URL-safe (letters, numbers, hyphens). Blank = the built-in defaults. Removing a category never hides existing items.
          </p>
          {text("Photo categories", catText.photos, (v) => setCatText((t) => ({ ...t, photos: v })), "wildlife, macro, landscape, street, general")}
          {text("Video categories", catText.videos, (v) => setCatText((t) => ({ ...t, videos: v })), "general, lore, tutorial, walk")}
          {text("Audio categories", catText.audio, (v) => setCatText((t) => ({ ...t, audio: v })), "general, music, talk, ambient")}
        </>)}

        {section("Analytics", <>
          <p className="text-xs text-gray-600 m-0">
            Privacy-friendly <a href="https://tinylytics.app" target="_blank" rel="noopener noreferrer" className="text-accent-400 hover:underline">Tinylytics</a> page-view tracking. Enter your site id to turn on collection — no file editing. (The in-app dashboard also needs an API key, still set via env.)
          </p>
          {text("Tinylytics site id", cfg.analytics.siteId, (v) => setAnalytics({ siteId: v }))}
          {text("Embed id (optional)", cfg.analytics.embedId, (v) => setAnalytics({ embedId: v }), "only if your embed code differs from the site id")}
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
