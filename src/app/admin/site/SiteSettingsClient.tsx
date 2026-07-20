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
  analyticsStatus,
  analyticsKey,
  encryptionAvailable,
  profile,
  profileDefaults,
}: {
  defaults: RuntimeSiteConfig;
  effective: RuntimeSiteConfig;
  overrides: Record<string, string>;
  accent: { accentColor: string; themeAccents: Record<string, string> };
  analyticsStatus: { embedCode: string | null; unresolved: boolean };
  analyticsKey: { configured: boolean; source: "db" | "env" | null };
  encryptionAvailable: boolean;
  profile: {
    authorName: string; authorTagline: string; authorBio: string;
    actorSummary: string; avatarPath: string; bannerPath: string;
  };
  profileDefaults: { avatarPath: string; bannerPath: string };
}) {
  const [cfg, setCfg] = useState<RuntimeSiteConfig>(effective);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [hasOverrides, setHasOverrides] = useState(Object.keys(overrides).length > 0);
  // Live analytics-embed status (#288) — refreshed from each save response.
  const [analyticsStat, setAnalyticsStat] = useState(analyticsStatus);
  // Encrypted Tinylytics API-key status (#59) — its own route (the key is a
  // secret, never round-tripped through the plaintext site-config save).
  const [keyStatus, setKeyStatus] = useState(analyticsKey);
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);

  /* ---- Profile overlay (#59) — name/tagline/bio/summary + avatar/banner ---- */
  // Held separately from `cfg` because the profile is a DIFFERENT store (the
  // SiteSettings overlay behind the AP actor), written via update_profile.
  const [prof, setProf] = useState(profile);
  const [savedProf, setSavedProf] = useState(profile); // last known-persisted values
  const [uploading, setUploading] = useState<"avatar" | "banner" | null>(null);
  const setProfile = (patch: Partial<typeof profile>) => setProf((p) => ({ ...p, ...patch }));

  /** Upload an image via /api/media (unchanged) and store the returned path. */
  async function uploadImage(kind: "avatar" | "banner", file: File) {
    if (file.size > 8 * 1024 * 1024) {
      setResult({ ok: false, msg: "That image is over 8 MB — please pick a smaller one." });
      return;
    }
    setUploading(kind);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/media", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Surface the real reason — a 403 here usually means you're browsing on
        // an origin that doesn't match SITE_URL, which trips the CSRF check.
        setResult({ ok: false, msg: data.error || `Upload failed (${res.status}). If this is a 403, check that you're browsing on your configured SITE_URL.` });
        return;
      }
      setProfile(kind === "avatar" ? { avatarPath: data.url } : { bannerPath: data.url });
      setResult({ ok: true, msg: "Image uploaded — press Save to apply it." });
    } catch {
      setResult({ ok: false, msg: "Upload failed." });
    } finally {
      setUploading(null);
    }
  }

  /**
   * Persist ONLY changed profile fields. The dirty-diff is load-bearing, not an
   * optimisation: updateProfile federates an actor `Update` to every follower
   * whenever a federated key is merely PRESENT in the body (not when its value
   * differs), so sending the whole profile on each save would spam followers on
   * every settings save (#276's lesson, new call site).
   */
  async function saveProfile(): Promise<boolean> {
    const body: Record<string, string> = {};
    (Object.keys(prof) as (keyof typeof prof)[]).forEach((k) => {
      if (prof[k] !== savedProf[k]) body[k] = prof[k];
    });
    if (Object.keys(body).length === 0) return true; // nothing changed → no request, no federation
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_profile", ...body }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setResult({ ok: false, msg: d.error || "Couldn't save your profile." });
        return false;
      }
      setSavedProf(prof);
      return true;
    } catch {
      setResult({ ok: false, msg: "Couldn't save your profile." });
      return false;
    }
  }

  /** Set or clear the encrypted API key via the dedicated route (never echoes the key). */
  async function postAnalyticsKey(payload: { apiKey: string } | { clear: true }): Promise<void> {
    setKeyBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/analytics-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, msg: data.error || "Couldn't save the API key." });
        return;
      }
      setKeyStatus(data.status);
      setKeyInput("");
      setResult({ ok: true, msg: "clear" in payload ? "API key cleared." : "API key saved — the dashboard applies within a minute." });
    } catch {
      setResult({ ok: false, msg: "Couldn't save the API key." });
    } finally {
      setKeyBusy(false);
    }
  }

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
      if (data.analyticsStatus) setAnalyticsStat(data.analyticsStatus);
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
      "layout.header": cfg.layout.header,
      "layout.footer": cfg.layout.footer,
      "layout.shell": cfg.layout.shell,
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
    const okProfile = await saveProfile(); // ditto; dirty-diffed, no-op if unchanged
    if (okConfig) setHasOverrides(true);
    if (okConfig && (!okAccent || !okProfile)) {
      // post() set a success message; correct it if an overlay write failed.
      const failed = [!okAccent && "the accent colour", !okProfile && "your profile"].filter(Boolean).join(" or ");
      setResult({ ok: false, msg: `Settings saved, but ${failed} didn't.` });
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
        "theme.id", "layout.feed", "layout.header", "layout.footer", "layout.shell", "contact.email",
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

        {section("Your profile", <>
          <p className="text-xs text-gray-600 m-0">
            You — as shown on <code>/about</code>, in your Fediverse profile, and to apps. Separate from the site
            name above. Changes to your name, summary, avatar or banner federate an update to your followers.
          </p>
          {text("Display name", prof.authorName, (v) => setProfile({ authorName: v }))}
          {text("Tagline", prof.authorTagline, (v) => setProfile({ authorTagline: v }), "Writer, photographer, maker")}
          {text("Bio", prof.authorBio, (v) => setProfile({ authorBio: v }), "Shown on your About page")}
          {text("Fediverse summary", prof.actorSummary, (v) => setProfile({ actorSummary: v }), "Blank = use your bio")}

          {(["avatar", "banner"] as const).map((kind) => {
            const key = kind === "avatar" ? "avatarPath" : "bannerPath";
            const current = prof[key];
            const isDefault = !current || current === profileDefaults[key];
            return (
              <div key={kind} className="flex flex-col gap-1 text-xs text-gray-400">
                <span>{kind === "avatar" ? "Avatar" : "Banner"}</span>
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={current || profileDefaults[key]}
                    alt=""
                    className={`bg-surface-800 border border-surface-700 object-cover ${
                      kind === "avatar" ? "w-12 h-12 rounded-full" : "w-24 h-12 rounded"
                    }`}
                  />
                  <label className="btn-outlined text-xs cursor-pointer">
                    {uploading === kind ? "Uploading…" : "Choose image"}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      disabled={uploading !== null}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = ""; // allow re-picking the same file
                        if (f) void uploadImage(kind, f);
                      }}
                    />
                  </label>
                  {!isDefault && (
                    <button
                      type="button"
                      onClick={() => setProfile({ [key]: "" } as Partial<typeof profile>)}
                      className="text-gray-400 hover:text-white underline"
                    >
                      Revert to default
                    </button>
                  )}
                </div>
                <span className="text-gray-600">
                  {isDefault ? "Using the built-in default." : "Press Save to apply."}
                </span>
              </div>
            );
          })}
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
          {select(
            "Header layout",
            cfg.layout.header,
            [
              { value: "", label: "Inherit from theme" },
              { value: "bar", label: "Bar — sticky top bar, links inline" },
              { value: "centered", label: "Centered — masthead over a centered nav row" },
              { value: "minimal", label: "Minimal — just your name and a menu button" },
            ],
            (v) => setLayout({ header: v }),
            "How the header renders across every page. Each theme picks a default; override it here.",
          )}
          {select(
            "Footer layout",
            cfg.layout.footer,
            [
              { value: "", label: "Inherit from theme" },
              { value: "row", label: "Row — credit, badges and links in one row" },
              { value: "minimal", label: "Minimal — a single quiet line" },
              { value: "columns", label: "Columns — a sitemap footer" },
            ],
            (v) => setLayout({ footer: v }),
            "How the footer renders across every page. Each theme picks a default; override it here.",
          )}
          {select(
            "Page width",
            cfg.layout.shell,
            [
              { value: "", label: "Inherit from theme" },
              { value: "normal", label: "Normal — each page uses its natural width" },
              { value: "narrow", label: "Narrow — a tighter reading column" },
              { value: "sidebar", label: "Sidebar — content beside about / recent / links" },
            ],
            (v) => setLayout({ shell: v }),
            "The frame around your public pages (your admin screens are unaffected).",
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
            Privacy-friendly <a href="https://tinylytics.app" target="_blank" rel="noopener noreferrer" className="text-accent-400 hover:underline">Tinylytics</a> page-view tracking. Enter your numeric site id — the tracking embed code is derived from it automatically when an API key is set. Add your API key below to auto-derive the embed <em>and</em> unlock the in-app dashboard, kudos and leaderboard.
          </p>
          {analyticsStat.embedCode ? (
            <p className="text-xs text-green-400 m-0">✓ Collecting pageviews — embed <code className="text-green-300">{analyticsStat.embedCode}</code>.</p>
          ) : analyticsStat.unresolved ? (
            <p className="text-xs text-amber-400 m-0">
              ⚠️ Analytics is set but <strong>no pageviews are being collected</strong> — the embed code couldn&apos;t be resolved from your site id. Add your API key below (so the embed code auto-derives), or paste your embed code (uid) below.
            </p>
          ) : null}
          {text("Tinylytics site id (numeric)", cfg.analytics.siteId, (v) => setAnalytics({ siteId: v }), "e.g. 3461")}
          {text("Embed code / uid (optional override)", cfg.analytics.embedId, (v) => setAnalytics({ embedId: v }), "only needed without an API key — the uid, not the numeric id")}

          {/* API key (#59) — encrypted at rest, its own route (secret, never echoed). */}
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            <span>Tinylytics API key {keyStatus.configured && (
              <span className="text-green-400">· configured{keyStatus.source === "env" ? " (from env)" : ""}</span>
            )}</span>
            <input
              type="password"
              value={keyInput}
              placeholder={keyStatus.configured ? "•••••••• (saved — enter a new key to replace)" : "paste your Tinylytics API key"}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
              disabled={!encryptionAvailable}
              className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white disabled:opacity-50"
            />
            {!encryptionAvailable ? (
              <span className="text-amber-400">Set <code>ADMIN_SECRET</code> to store the key encrypted at rest.</span>
            ) : (
              <span className="text-gray-600">Stored AES-256-GCM-encrypted; never shown again after saving.</span>
            )}
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => postAnalyticsKey({ apiKey: keyInput })}
              disabled={keyBusy || !encryptionAvailable || !keyInput.trim()}
              className="btn-primary text-xs disabled:opacity-50"
            >
              {keyBusy ? "Saving…" : "Save API key"}
            </button>
            {keyStatus.source === "db" && (
              <button
                type="button"
                onClick={() => postAnalyticsKey({ clear: true })}
                disabled={keyBusy}
                className="text-xs text-gray-400 hover:text-white underline disabled:opacity-40"
              >
                Clear saved key
              </button>
            )}
          </div>
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
