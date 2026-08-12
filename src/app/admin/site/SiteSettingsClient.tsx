"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { RuntimeSiteConfig } from "@/lib/site-settings";
// Bounds only — a leaf module with no imports, so this stays client-safe
// (site-settings.ts pulls in Prisma).
import { MAX_EXPLORE_LOOKBACK_DAYS, MAX_EXPLORE_STORED } from "@/lib/explore-limits";
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
  pushKey,
  aliases,
  encryptionAvailable,
  uploadsDefault,
  storage,
  profile,
  profileDefaults,
}: {
  defaults: RuntimeSiteConfig;
  effective: RuntimeSiteConfig;
  overrides: Record<string, string>;
  accent: { accentColor: string; themeAccents: Record<string, string> };
  analyticsStatus: { embedCode: string | null; unresolved: boolean };
  analyticsKey: { configured: boolean; source: "db" | "env" | null };
  pushKey: { configured: boolean; source: "db" | "env" | null; subject: string };
  aliases: string[];
  encryptionAvailable: boolean;
  /** The built-in uploads path, shown as the placeholder when nothing is set. */
  uploadsDefault: string;
  /** Live disk figures (#385). `usage` is null until the scheduler's first scan. */
  storage: {
    uploadsDir: string;
    status: "ok" | "low" | "critical" | "unknown";
    availableBytes: number | null;
    volumeBytes: number | null;
    usage: { totalBytes: number; fediCacheBytes: number; ownBytes: number; measuredAt: string } | null;
  };
  profile: {
    authorName: string; authorTagline: string; authorBio: string;
    actorSummary: string; avatarPath: string; bannerPath: string;
  };
  profileDefaults: { avatarPath: string; bannerPath: string };
}) {
  const [cfg, setCfg] = useState<RuntimeSiteConfig>(effective);
  const [saving, setSaving] = useState(false);
  const [diagCopied, setDiagCopied] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [hasOverrides, setHasOverrides] = useState(Object.keys(overrides).length > 0);
  // Live analytics-embed status (#288) — refreshed from each save response.
  const [analyticsStat, setAnalyticsStat] = useState(analyticsStatus);
  // Encrypted Tinylytics API-key status (#59) — its own route (the key is a
  // secret, never round-tripped through the plaintext site-config save).
  const [keyStatus, setKeyStatus] = useState(analyticsKey);
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  // Web-push (VAPID) keys (#59) — generate/clear via a dedicated route; the
  // private key is encrypted at rest and never sent to the browser.
  const [pushStatus, setPushStatus] = useState(pushKey);
  const [pushBusy, setPushBusy] = useState(false);
  // Account aliases / alsoKnownAs (#326) — its own route; identity-adjacent, so
  // it's cookie-only and never round-tripped through the site-config save.
  const [aliasText, setAliasText] = useState(aliases.join("\n"));
  const [aliasSaved, setAliasSaved] = useState<string[]>(aliases);
  const [aliasBusy, setAliasBusy] = useState(false);
  // Admin password (#356) — its own route; the hash never round-trips through
  // the plaintext site-config save.
  const [pwHas, setPwHas] = useState<boolean | null>(null);
  // Federation identity (#326) — its own route, and refused outright once the
  // instance has published anything.
  const [ident, setIdent] = useState<{
    siteUrl: string; fediHandle: string; fediDomain: string; fediAddress: string;
    locked: boolean; lockedReason: string | null;
  } | null>(null);
  const [identBusy, setIdentBusy] = useState(false);
  const [identDone, setIdentDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/identity")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setIdent(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function saveIdentity(): Promise<void> {
    if (!ident) return;
    setIdentBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteUrl: ident.siteUrl, fediHandle: ident.fediHandle, fediDomain: ident.fediDomain,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setResult({ ok: false, msg: data?.error || "Couldn't change your address." });
        return;
      }
      setIdent((c) => (c ? { ...c, ...data } : c));
      setIdentDone(true);
    } catch {
      setResult({ ok: false, msg: "Couldn't reach the server — nothing was changed." });
    } finally {
      setIdentBusy(false);
    }
  }
  // Leaving for another server (#347) — its own route, cookie-only, and never
  // part of the plaintext site-config save: declaring a move tells every
  // follower's server to re-point its follow, which is not something a settings
  // batch should be able to do as a side effect.
  const [move, setMove] = useState<{
    movedTo: string | null; movedAt: string | null; handle: string | null;
    cooldownDaysLeft: number; cooldownDays: number; followers: number;
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/move")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setMove(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function postMove(payload: Record<string, unknown>): Promise<void> {
    setMoveBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // The refusal text is the useful part — "the new account doesn't list
        // this one as an alias yet" is an instruction, not an error.
        setResult({ ok: false, msg: data?.error || "Couldn't do that." });
        return;
      }
      setMove((c) => (c ? { ...c, ...data } : c));
      setMoveTarget("");
      setResult({
        ok: true,
        msg: data.movedTo
          ? `Move sent. Your followers' servers will move them to ${data.handle || data.movedTo}.`
          : "Move cancelled. Your profile no longer says you've moved.",
      });
    } catch {
      setResult({ ok: false, msg: "Couldn't reach the server — nothing was changed." });
    } finally {
      setMoveBusy(false);
    }
  }

  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/password")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setPwHas(!!d.hasPassword); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function savePassword(): Promise<void> {
    if (pwNext !== pwConfirm) {
      setResult({ ok: false, msg: "Those two passwords don't match." });
      return;
    }
    setPwBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNext }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setResult({ ok: false, msg: data?.error || "Couldn't change the password." });
        return;
      }
      setPwHas(true);
      setPwCurrent(""); setPwNext(""); setPwConfirm("");
      const n = data?.otherSessionsRevoked ?? 0;
      setResult({
        ok: true,
        msg: n > 0
          ? `Password updated. ${n} other session${n === 1 ? "" : "s"} signed out.`
          : "Password updated.",
      });
    } catch {
      setResult({ ok: false, msg: "Couldn't reach the server — nothing was changed." });
    } finally {
      setPwBusy(false);
    }
  }

  async function saveAliases(): Promise<void> {
    setAliasBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aliases: aliasText }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setResult({ ok: false, msg: data?.error || "Couldn't save aliases." });
        return;
      }
      setAliasSaved(data.aliases || []);
      setAliasText((data.aliases || []).join("\n"));
      setResult({
        ok: true,
        msg: (data.aliases || []).length
          ? `Saved ${(data.aliases || []).length} alias(es).`
          : "Aliases cleared.",
      });
    } finally {
      setAliasBusy(false);
    }
  }

  async function postPushKeys(action: "generate" | "clear"): Promise<void> {
    if (action === "generate" && pushStatus.configured &&
        !confirm("Generate new push keys? Every device currently enrolled for push will stop receiving notifications until it re-enables them.")) {
      return;
    }
    setPushBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/push-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, msg: data.error || "Couldn't update the push keys." });
        return;
      }
      setPushStatus(data.status);
      setResult({ ok: true, msg: action === "clear" ? "Push keys cleared." : "Push keys generated — re-enable notifications on each device." });
    } catch {
      setResult({ ok: false, msg: "Couldn't update the push keys." });
    } finally {
      setPushBusy(false);
    }
  }

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

  /** Fetch the support bundle and put it on the clipboard (#395). */
  async function copyDiagnostics() {
    try {
      const res = await fetch("/api/admin/diagnostics");
      if (!res.ok) throw new Error("failed");
      await navigator.clipboard.writeText(await res.text());
      setDiagCopied(true);
      setTimeout(() => setDiagCopied(false), 2000);
    } catch {
      setResult({ ok: false, msg: "Couldn't build the support bundle." });
    }
  }

  async function post(
    settings: Record<string, string | null>,
    acknowledgeEphemeral = false,
  ): Promise<boolean> {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/site-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings, acknowledgeEphemeral }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409 = the path works but isn't durable (#387). Ask once, then honour
        // the answer — the operator may well have a reason, and the point is to
        // remove the surprise rather than the freedom.
        if (res.status === 409 && data.confirm === "acknowledgeEphemeral") {
          setSaving(false);
          const proceed = window.confirm(
            `${data.error}\n\nSave this location anyway?`,
          );
          return proceed ? post(settings, true) : false;
        }
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
      "explore.enabled": String(cfg.explore.enabled),
      "explore.replyParents": String(cfg.explore.replyParents),
      "explore.lookbackDays": String(cfg.explore.lookbackDays),
      "explore.maxStored": String(cfg.explore.maxStored),
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
      "sidebar.side": cfg.sidebar.side,
      "sidebar.blocks": sidebarText,
      "storage.uploadsDir": cfg.storage.uploadsDir,
      "storage.fediCacheMb": String(cfg.storage.fediCacheMb),
      "security.adminSessionTtlDays": String(cfg.security.adminSessionTtlDays),
      "security.appTokenTtlDays": String(cfg.security.appTokenTtlDays),
      "contact.email": cfg.contact.email,
      "about.heading": cfg.about.heading,
      "about.markdown": cfg.about.markdown,
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
        "explore.enabled", "explore.replyParents", "explore.lookbackDays", "explore.maxStored",
        "nav.journal", "nav.articles", "nav.photography", "nav.videos", "nav.audio", "nav.about",
        "footer.webringUrl", "footer.webringLabel", "footer.badgeSrc", "footer.badgeHref",
        "footer.badgeAlt", "footer.fundingUrl", "footer.fundingLabel",
        "download.macos.enabled", "download.macos.releaseUrl", "download.macos.appStoreUrl",
        "theme.id", "layout.feed", "layout.header", "layout.footer", "layout.shell",
        "sidebar.side", "sidebar.blocks", "storage.uploadsDir", "storage.fediCacheMb",
        "security.adminSessionTtlDays", "security.appTokenTtlDays", "contact.email",
        "about.heading", "about.markdown",
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
  const setSidebar = (patch: Partial<RuntimeSiteConfig["sidebar"]>) => setCfg((c) => ({ ...c, sidebar: { ...c.sidebar, ...patch } }));
  const setSecurity = (patch: Partial<RuntimeSiteConfig["security"]>) => setCfg((c) => ({ ...c, security: { ...c.security, ...patch } }));
  const setExplore = (patch: Partial<RuntimeSiteConfig["explore"]>) => setCfg((c) => ({ ...c, explore: { ...c.explore, ...patch } }));
  /** Bytes → a figure a person reads, not a computer. */
  const gb = (n: number) => {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
    return `${Math.round(n / 1024)} KB`;
  };

  const setStorage = (patch: Partial<RuntimeSiteConfig["storage"]>) => setCfg((c) => ({ ...c, storage: { ...c.storage, ...patch } }));
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

  // Sidebar block order (#307) — same raw-text treatment as categories above, so
  // typing a comma doesn't get eaten by a `join()`-bound controlled input.
  const [sidebarText, setSidebarText] = useState(effective.sidebar.blocks.join(", "));
  useEffect(() => { setSidebarText(cfg.sidebar.blocks.join(", ")); }, [cfg.sidebar.blocks]);

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
  // The id makes each section deep-linkable — /admin/site#security is where the
  // sign-in screen sends an owner still using ADMIN_SECRET (#411).
  const section = (title: string, children: React.ReactNode) => (
    <section
      id={title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}
      className="py-4 border-b border-surface-800 last:border-b-0 scroll-mt-6"
    >
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
          {ident && (
            <div className="rounded-lg border border-surface-700 p-3 flex flex-col gap-2">
              <p className="text-xs font-semibold text-content m-0">Your Fediverse address</p>
              <p className="text-xs text-gray-600 m-0">
                Currently <code>{ident.fediAddress}</code>, served from <code>{ident.siteUrl}</code>.
              </p>

              {ident.locked ? (
                <p className="text-xs text-amber-400/90 m-0">
                  <strong>This can&apos;t be changed now.</strong> {ident.lockedReason}
                </p>
              ) : (
                <>
                  <p className="text-xs text-gray-600 m-0">
                    You haven&apos;t published anything yet, so this is still safe to set. After you do,
                    it&apos;s fixed: every post carries this address inside it, and other servers keep
                    the first one they ever saw.
                  </p>
                  {text("Site URL", ident.siteUrl, (v) => setIdent((c) => (c ? { ...c, siteUrl: v } : c)), "https://yourdomain.com")}
                  {/* Honest about the limit rather than implying validation we
                      don't do (#431). We check the shape and that the address is
                      reachable from the internet at all — we cannot check that
                      you control it, and a legitimate operator behind a reverse
                      proxy or a tunnel routinely serves a domain nothing here
                      can see locally, so a hard check would be wrong. */}
                  <p className="text-xs text-gray-600 m-0">
                    We can&apos;t check that you actually control this domain. If it&apos;s wrong,
                    federation stops working silently — other servers look for you at that address
                    and find nothing — and you may lose access to this panel until you put it right.
                    Getting it wrong is recoverable before you publish; afterwards it needs{" "}
                    <code>scripts/set-identity.ts</code>.
                  </p>
                  {text("Handle", ident.fediHandle, (v) => setIdent((c) => (c ? { ...c, fediHandle: v } : c)), "me")}
                  {text("Domain", ident.fediDomain, (v) => setIdent((c) => (c ? { ...c, fediDomain: v } : c)), "yourdomain.com")}
                  <div>
                    <button
                      type="button"
                      onClick={saveIdentity}
                      disabled={identBusy}
                      className="btn-primary text-xs disabled:opacity-50"
                    >
                      {identBusy ? "Saving…" : "Set my address"}
                    </button>
                  </div>
                  {identDone && (
                    <p className="text-xs text-amber-400/90 m-0">
                      Saved — <strong>restart FediHome</strong> to be sure every worker picks it up.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </>)}

        {section("About page", <>
          <p className="text-xs text-gray-600 m-0">
            The <code>/about</code> page. Written in Markdown — headings, links, lists,
            <code>---</code> for a divider. Leave both blank to use the built-in text, which
            includes your bio and follows your Fediverse address if it ever changes.
          </p>
          {text("Heading", cfg.about.heading, (v) => set({ about: { ...cfg.about, heading: v } }), "About")}
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            <span>Page content</span>
            <textarea
              value={cfg.about.markdown}
              onChange={(e) => set({ about: { ...cfg.about, markdown: e.target.value } })}
              rows={14}
              placeholder="Leave blank for the built-in text."
              className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white font-mono leading-relaxed"
            />
            <span className="text-gray-600">
              Your contact details are added underneath automatically — you don&apos;t need to
              repeat them here.
            </span>
          </label>
        </>)}

        {section("Support bundle", <>
          <p className="text-xs text-gray-600 m-0">
            A plain-text summary of this instance — version, install shape, whether the
            scheduler is running, disk space, which integrations are set up. Useful to paste
            into a bug report when something isn&apos;t working.
          </p>
          <p className="text-xs text-gray-600 m-0">
            It contains <strong>no passwords, tokens or keys</strong>. Environment variables are
            listed by name with whether they&apos;re set, never by value. Nothing is sent
            anywhere — you get the text and decide what to do with it.
          </p>
          <div className="flex items-center gap-3">
            <button type="button" onClick={copyDiagnostics} className="btn-outlined text-xs !py-1.5">
              {diagCopied ? "Copied ✓" : "Copy support bundle"}
            </button>
            <a href="/api/admin/diagnostics" download="fedihome-support.txt" className="text-xs text-gray-400 hover:text-white">
              Download
            </a>
          </div>
        </>)}

        {section("Export your content", <>
          <p className="text-xs text-gray-600 m-0">
            Everything you&apos;ve published — posts, photos, videos, audio, your own Fediverse
            posts and approved comments — as one file, with the original text and all the
            metadata. No shell, no database tools.
          </p>
          <p className="text-xs text-gray-600 m-0">
            It streams as it&apos;s built, so a large site won&apos;t run your server out of
            memory, and a partial download is still readable up to the last complete line.
            Your uploaded files aren&apos;t in it — they&apos;re already on your disk — but every
            reference to them is, so an archive can be put back together.
          </p>
          <a href="/api/admin/export" className="btn-outlined text-xs !py-1.5 self-start">
            Download export
          </a>
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
          {cfg.layout.shell === "sidebar" && (
            <>
              {select(
                "Sidebar side",
                cfg.sidebar.side,
                [
                  { value: "right", label: "Right" },
                  { value: "left", label: "Left" },
                ],
                (v) => setSidebar({ side: v as RuntimeSiteConfig["sidebar"]["side"] }),
                "Which side of your content the sidebar sits on. On mobile your content always comes first.",
              )}
              {text(
                "Sidebar blocks",
                sidebarText,
                setSidebarText,
                "about, recent, sections, connect",
              )}
              <p className="text-xs text-gray-600 m-0 -mt-1">
                Comma-separated, in the order you want them. Leave a block out to hide it — drop{" "}
                <code>sections</code> if you don&apos;t want your nav in both the header and the sidebar.
                Blank uses the default order. Available: <code>about</code>, <code>recent</code>,{" "}
                <code>sections</code>, <code>connect</code>.
              </p>
            </>
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

        {section("Explore", <>
          <p className="text-xs text-gray-600 m-0">
            A second feed showing posts from people you <em>don&apos;t</em> follow, surfaced
            because someone you <em>do</em> follow boosted them or replied to them. It appears
            as an <strong>Explore</strong> tab next to your timeline, and only for you —
            nothing here is ever shown on your public pages.
          </p>
          {check("Turn on the Explore feed", cfg.explore.enabled, (v) => setExplore({ enabled: v }))}
          {cfg.explore.enabled && (
            <>
              {check(
                "Also fetch the posts your follows replied to",
                cfg.explore.replyParents,
                (v) => setExplore({ replyParents: v }),
              )}
              <p className="text-xs text-gray-600 m-0">
                Boosts need nothing fetched — those posts are already on your server, just
                hidden from your timeline. Replies are different: what arrives is your
                friend&apos;s reply, not the post they replied to, so FediHome goes and gets
                it. That&apos;s a small number of requests to other servers each hour, at most
                ten, and only for posts that are public.
              </p>
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                <span>How far back to look (days)</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_EXPLORE_LOOKBACK_DAYS}
                  value={cfg.explore.lookbackDays}
                  onChange={(e) => setExplore({ lookbackDays: Number(e.target.value) })}
                  className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white font-mono"
                />
                <span className="text-gray-600">
                  Only replies received in this window are followed up. A week suits most
                  people; longer mostly means chasing conversations nobody is reading now.
                </span>
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                <span>Keep at most this many discovered posts</span>
                <input
                  type="number"
                  min={0}
                  max={MAX_EXPLORE_STORED}
                  value={cfg.explore.maxStored}
                  onChange={(e) => setExplore({ maxStored: Number(e.target.value) })}
                  className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white font-mono"
                />
                <span className="text-gray-600">
                  The oldest are deleted past this, along with any images cached for them, so
                  Explore can&apos;t quietly fill your disk. <strong>0</strong> means no limit.
                  Boosted posts aren&apos;t counted here — you already had those.
                </span>
              </label>
            </>
          )}
          <p className="text-xs text-gray-600 m-0">
            Posts from accounts or domains you&apos;ve blocked never appear, and are never
            downloaded — the check runs on whoever <em>wrote</em> the post, not on whoever
            boosted or replied to it.
          </p>
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

        {section("Phone notifications (Web Push)", <>
          <p className="text-xs text-gray-600 m-0">
            Push notifications to your installed app (PWA) need a VAPID keypair. Generate one here — no
            <code> npx web-push </code> or <code>.env</code> editing. The private key is stored encrypted;
            after generating, enable notifications on each device from the 🔔 menu.
          </p>
          <p className="text-xs m-0">
            {pushStatus.configured ? (
              <span className="text-green-400">✓ Push keys configured{pushStatus.source === "env" ? " (from env)" : ""}.</span>
            ) : (
              <span className="text-gray-500">No push keys yet — notifications are off until you generate them.</span>
            )}
          </p>
          {pushStatus.configured && (
            <p className="text-xs text-amber-400/80 m-0">
              ⚠️ Regenerating replaces your keys and <strong>unsubscribes every device</strong> — each one has to re-enable push.
            </p>
          )}
          {!encryptionAvailable && (
            <p className="text-xs text-amber-400 m-0">Set <code>ADMIN_SECRET</code> to store the private key encrypted at rest.</p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => postPushKeys("generate")}
              disabled={pushBusy || !encryptionAvailable}
              className="btn-primary text-xs disabled:opacity-50"
            >
              {pushBusy ? "Working…" : pushStatus.configured ? "Regenerate keys" : "Generate keys"}
            </button>
            {pushStatus.source === "db" && (
              <button
                type="button"
                onClick={() => postPushKeys("clear")}
                disabled={pushBusy}
                className="text-xs text-gray-400 hover:text-white underline disabled:opacity-40"
              >
                Clear saved keys
              </button>
            )}
          </div>
        </>)}

        {section("Moving here from another account", <>
          <p className="text-xs text-gray-600 m-0">
            Moving to FediHome from Mastodon (or anywhere else that speaks ActivityPub) and want to
            bring your followers? Add your <strong>old</strong> account here first, then start the
            move from that old account. Their server checks this list before it will move anyone —
            without it, the move is refused and your followers stay behind.
          </p>
          <p className="text-xs text-gray-600 m-0">
            Use the full profile address, one per line — e.g.{" "}
            <code>https://mastodon.social/users/you</code>. Anything that isn&apos;t a web address is
            ignored.
          </p>
          <textarea
            value={aliasText}
            onChange={(e) => setAliasText(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="https://mastodon.social/users/you"
            className="w-full rounded-lg border border-surface-700 bg-surface-950/60 p-2 font-mono text-xs text-white"
          />
          <p className="text-xs m-0">
            {aliasSaved.length > 0 ? (
              <span className="text-green-400">
                ✓ {aliasSaved.length} alias{aliasSaved.length === 1 ? "" : "es"} published on your profile.
              </span>
            ) : (
              <span className="text-gray-500">No aliases set.</span>
            )}
          </p>
          <p className="text-xs text-amber-400/80 m-0">
            ⚠️ Keep the old account online until the move finishes. Its server has to still be
            answering for the move to be verified — once it&apos;s gone, followers can&apos;t be
            moved by anyone.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={saveAliases}
              disabled={aliasBusy}
              className="btn-primary text-xs disabled:opacity-50"
            >
              {aliasBusy ? "Saving…" : "Save aliases"}
            </button>
          </div>
        </>)}

        {section("Moving away from here", <>
          {move?.movedTo ? (
            <>
              <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3 flex flex-col gap-1.5">
                <p className="text-xs font-semibold text-amber-300 m-0">
                  This account has moved to {move.handle}
                </p>
                <p className="text-xs text-gray-400 m-0">
                  Your profile now tells every server that you&apos;re at{" "}
                  <code>{move.movedTo}</code>, and this account has stopped publishing new
                  posts. <strong>Keep this instance running.</strong> Servers verify the move
                  by fetching this profile, so followers whose server hasn&apos;t checked in
                  yet can only follow you across while it&apos;s still answering — the
                  recommendation is at least a year.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => postMove({ action: "resend" })}
                  disabled={moveBusy}
                  className="btn-primary text-xs disabled:opacity-50"
                >
                  {moveBusy ? "Sending…" : "Send the move again"}
                </button>
                <button
                  type="button"
                  onClick={() => postMove({ action: "cancel" })}
                  disabled={moveBusy}
                  className="text-xs text-gray-400 hover:text-white underline disabled:opacity-40"
                >
                  Cancel the move
                </button>
              </div>
              <p className="text-xs text-gray-600 m-0">
                <strong>Send again</strong> is safe to press as often as you like — servers
                that already moved your followers ignore a repeat. It&apos;s worth doing if
                someone tells you their follow didn&apos;t come across.{" "}
                <strong>Cancelling stops telling people you&apos;ve moved; it does not bring
                followers back</strong> — anyone whose server already moved them is following
                the new account now, and nothing here can reach into their server.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-gray-600 m-0">
                Leaving for another server and want to take your{" "}
                <strong>{move?.followers ?? 0} follower{move?.followers === 1 ? "" : "s"}</strong>{" "}
                with you? Set up the new account first, add{" "}
                <code>{ident?.siteUrl ? `${ident.siteUrl}/ap/actor` : "this account"}</code> to
                its aliases, then put its address here.
              </p>
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                <span>The account you&apos;re moving to</span>
                <input
                  type="text"
                  value={moveTarget}
                  onChange={(e) => setMoveTarget(e.target.value)}
                  spellCheck={false}
                  placeholder="https://mastodon.social/users/you"
                  className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white font-mono"
                />
                <span className="text-gray-600">
                  The full profile address of the new account. We check it lists this account
                  as an alias before sending anything — if it doesn&apos;t, every server would
                  refuse the move and your followers would quietly stay here.
                </span>
              </label>
              <div className="rounded-lg border border-surface-700 p-3 flex flex-col gap-1.5">
                <p className="text-xs font-semibold text-content m-0">Before you press this</p>
                <ul className="text-xs text-gray-500 m-0 pl-4 list-disc flex flex-col gap-1">
                  <li><strong>Only followers move.</strong> Your posts, the people you follow, your blocks and your mutes all stay here.</li>
                  <li><strong>Keep this instance running afterwards.</strong> Every server verifies the move by fetching this profile. Take it down and the followers who hadn&apos;t moved yet can never be moved, by you or anyone.</li>
                  <li><strong>This account stops publishing.</strong> Replies and likes still work, so you don&apos;t abandon conversations mid-thread.</li>
                  <li>Moving somewhere <em>else</em> afterwards means waiting {move?.cooldownDays ?? 30} days.</li>
                </ul>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => postMove({ target: moveTarget })}
                  disabled={moveBusy || !moveTarget.trim()}
                  className="btn-primary text-xs disabled:opacity-50"
                >
                  {moveBusy ? "Checking…" : "Move my followers"}
                </button>
              </div>
            </>
          )}
        </>)}

        {section("Storage", <>
          <p className="text-xs text-gray-600 m-0">
            Where uploaded photos, audio and cached remote media are written on disk.
            Leave blank to keep them in <code>public/uploads</code> inside the install.
          </p>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            <span>Uploads directory</span>
            <input
              type="text"
              value={cfg.storage.uploadsDir}
              placeholder={uploadsDefault}
              onChange={(e) => setStorage({ uploadsDir: e.target.value })}
              className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white font-mono"
            />
            <span className="text-gray-600">
              An absolute path on a bigger disk or a mounted volume. It must already exist
              and be writable by FediHome — we check both before saving, and tell you which
              one failed. In Docker we also check it&apos;s on a mounted volume: a directory
              inside the container is deleted on the next rebuild, and you wouldn&apos;t find
              out until then.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            <span>Cache for other people&apos;s media (MB)</span>
            <input
              type="number"
              min={0}
              value={cfg.storage.fediCacheMb}
              onChange={(e) => setStorage({ fediCacheMb: Number(e.target.value) })}
              className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white font-mono"
            />
            <span className="text-gray-600">
              Images and video from posts in your feed are copied here so they load fast and
              don&apos;t leak your visitors&apos; IP addresses to other servers. When it goes over
              budget the oldest files are deleted. <strong>0</strong> turns caching off entirely —
              nothing is copied, and media then loads from the original server. This shares the
              disk with your own uploads, which are never touched by this.
            </span>
          </label>
          <div className="rounded-lg border border-surface-700 p-3 flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-content m-0">Disk usage</p>
            <p className="text-xs text-gray-600 m-0">
              Writing to <code>{storage.uploadsDir}</code>
            </p>
            {storage.availableBytes !== null && storage.volumeBytes !== null ? (
              <p
                className={`text-xs m-0 ${
                  storage.status === "critical"
                    ? "text-red-400"
                    : storage.status === "low"
                      ? "text-amber-400"
                      : "text-green-400"
                }`}
              >
                {storage.status === "critical"
                  ? "⚠️ Almost full — "
                  : storage.status === "low"
                    ? "⚠️ Running low — "
                    : "✓ "}
                <strong>{gb(storage.availableBytes)}</strong> free of {gb(storage.volumeBytes)}
              </p>
            ) : (
              <p className="text-xs text-gray-600 m-0">Free space couldn&apos;t be read on this system.</p>
            )}
            {storage.usage ? (
              <p className="text-xs text-gray-600 m-0">
                <strong>{gb(storage.usage.ownBytes)}</strong> your media ·{" "}
                <strong>{gb(storage.usage.fediCacheBytes)}</strong> cached from other servers
                {storage.usage.fediCacheBytes > 0 && (
                  <> — that cache is trimmed automatically and is safe to lose</>
                )}
              </p>
            ) : (
              <p className="text-xs text-gray-600 m-0">
                Usage hasn&apos;t been measured yet — it&apos;s counted in the background shortly after start-up.
              </p>
            )}
          </div>

          <p className="text-xs text-amber-400/90 m-0">
            <strong>Media already on disk is not moved.</strong> New uploads go to the new
            location; everything uploaded before it keeps being served from the old one, so
            nothing breaks and nothing is at risk. Move the old files across whenever suits
            you — or leave them where they are.
          </p>
          <p className="text-xs text-gray-600 m-0">
            Running in Docker? Point the bind mount at the same path, or the directory will
            be owned by root and the app (running as <code>node</code>) won&apos;t be able to
            write to it.
          </p>
        </>)}

        {section("Security", <>
          <div className="rounded-lg border border-surface-700 p-3 flex flex-col gap-2">
            <p className="text-xs font-semibold text-content m-0">
              {pwHas === false ? "Choose a password" : "Change your password"}
            </p>
            {pwHas === false && (
              <p className="text-xs text-amber-400/90 m-0">
                You&apos;re still signing in with <code>ADMIN_SECRET</code> — a 64-character
                key that was never meant to be typed. Pick a real password; your saved
                connections are unaffected.
              </p>
            )}
            <p className="text-xs text-gray-600 m-0">
              Separate from <code>ADMIN_SECRET</code>, so changing it is safe: your saved
              Bluesky, Threads, analytics and notification credentials keep working.
              Other signed-in devices are signed out.
            </p>
            <input
              type="password" autoComplete="current-password"
              placeholder={pwHas === false ? "Current ADMIN_SECRET" : "Current password"}
              value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)}
              className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
            />
            <input
              type="password" autoComplete="new-password" placeholder="New password (min 12 characters)"
              value={pwNext} onChange={(e) => setPwNext(e.target.value)}
              className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
            />
            <input
              type="password" autoComplete="new-password" placeholder="Confirm new password"
              value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)}
              className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
            />
            <div>
              <button
                type="button" onClick={savePassword}
                disabled={pwBusy || !pwCurrent || pwNext.length < 12 || !pwConfirm}
                className="btn-primary text-xs disabled:opacity-50"
              >
                {pwBusy ? "Saving…" : pwHas === false ? "Set password" : "Change password"}
              </button>
            </div>
          </div>

          <p className="text-xs text-gray-600 m-0">
            Session and token lifetimes, in days. Changes apply to <strong>newly-created</strong> sessions and
            tokens only — existing ones keep their original expiry.
          </p>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            <span>Admin session lifetime (days)</span>
            <input
              type="number" min={1} max={3650}
              value={cfg.security.adminSessionTtlDays}
              onChange={(e) => setSecurity({ adminSessionTtlDays: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
              className="w-28 bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
            />
            <span className="text-gray-600">How long you stay signed in to the admin panel. Default 30.</span>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            <span>App token lifetime (days)</span>
            <input
              type="number" min={0} max={3650}
              value={cfg.security.appTokenTtlDays}
              onChange={(e) => setSecurity({ appTokenTtlDays: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
              className="w-28 bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
            />
            <span className="text-gray-600">
              How long a generated app token lasts. <strong>0 = never expires</strong> (long-lived + revocable).
              Setting a limit starts expiring newly-issued tokens.
            </span>
          </label>
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
