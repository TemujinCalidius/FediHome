import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { siteSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() } } }));
vi.mock("@/../site.config", () => ({
  siteConfig: {
    name: "Env Site", description: "env desc",
    landingMode: false, landingHeadline: "env headline", landingSubhead: "env subhead", repoUrl: "https://env/repo",
    publicFeed: false, publicFeedTitle: "env feed", hideSocialGraph: false,
    nav: { showJournal: true, showArticles: true, showPhotography: true, showVideos: true, showAudio: true, showAbout: true },
    footer: { webringUrl: "", webringLabel: "Webring", badgeSrc: "", badgeHref: "", badgeAlt: "Badge", fundingUrl: "", fundingLabel: "Support" },
    download: { macosEnabled: false, macosReleaseUrl: "https://env/releases/latest", macosAppStoreUrl: "" },
    theme: { id: "default" },
  },
}));

import { getRuntimeSiteConfig, invalidateSiteConfigCache, siteConfigDefaults, applySiteConfig, validateSiteConfigValue } from "@/lib/site-settings";
import { buildNavLinks } from "@/lib/nav";
import { prisma } from "@/lib/db";

const rows = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSiteConfigCache();
  vi.mocked(prisma.siteSetting.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.siteSetting.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.siteSetting.deleteMany).mockResolvedValue({ count: 1 } as never);
});

describe("getRuntimeSiteConfig (#59)", () => {
  it("returns env defaults with no overrides", async () => {
    const cfg = await getRuntimeSiteConfig();
    expect(cfg).toEqual(siteConfigDefaults());
    expect(cfg.landing.mode).toBe(false);
    expect(cfg.nav.showJournal).toBe(true);
  });

  it("overlays bool + text overrides (env default otherwise)", async () => {
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "landing.mode": "true", "site.name": "DB Site", "nav.journal": "false" }) as never,
    );
    const cfg = await getRuntimeSiteConfig();
    expect(cfg.landing.mode).toBe(true);
    expect(cfg.name).toBe("DB Site");
    expect(cfg.nav.showJournal).toBe(false);
    expect(cfg.nav.showArticles).toBe(true); // untouched → env default
    expect(cfg.description).toBe("env desc");
  });

  it("overlays the macOS download group (#241): off by default, editable URLs", async () => {
    const base = await getRuntimeSiteConfig();
    expect(base.download).toEqual({ macosEnabled: false, macosReleaseUrl: "https://env/releases/latest", macosAppStoreUrl: "" });
    invalidateSiteConfigCache();
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      rows({ "download.macos.enabled": "true", "download.macos.appStoreUrl": "https://apps.apple.com/app/id1" }) as never,
    );
    const cfg = await getRuntimeSiteConfig();
    expect(cfg.download.macosEnabled).toBe(true);
    expect(cfg.download.macosAppStoreUrl).toBe("https://apps.apple.com/app/id1");
    expect(cfg.download.macosReleaseUrl).toBe("https://env/releases/latest"); // untouched → env default
  });

  it("overlays the theme id (#250): default otherwise, a saved override wins", async () => {
    expect((await getRuntimeSiteConfig()).theme.id).toBe("default");
    invalidateSiteConfigCache();
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(rows({ "theme.id": "default" }) as never);
    expect((await getRuntimeSiteConfig()).theme.id).toBe("default");
  });

  it("caches for a minute; invalidation forces a re-read", async () => {
    await getRuntimeSiteConfig();
    await getRuntimeSiteConfig();
    expect(prisma.siteSetting.findMany).toHaveBeenCalledTimes(1);
    invalidateSiteConfigCache();
    await getRuntimeSiteConfig();
    expect(prisma.siteSetting.findMany).toHaveBeenCalledTimes(2);
  });

  it("falls back to env defaults (uncached) when the DB is unreachable", async () => {
    vi.mocked(prisma.siteSetting.findMany).mockRejectedValue(new Error("db down"));
    expect((await getRuntimeSiteConfig()).name).toBe("Env Site");
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(rows({ "site.name": "Back" }) as never);
    expect((await getRuntimeSiteConfig()).name).toBe("Back"); // failure wasn't cached
  });
});

describe("validateSiteConfigValue (#59)", () => {
  it("bool fields accept only true/false", () => {
    expect(validateSiteConfigValue("landing.mode", "true")).toBe("true");
    expect(validateSiteConfigValue("landing.mode", "false")).toBe("false");
    expect(validateSiteConfigValue("landing.mode", "yes")).toBeNull();
  });
  it("theme.id only accepts a registered theme id (#250)", () => {
    expect(validateSiteConfigValue("theme.id", "default")).toBe("default");
    expect(validateSiteConfigValue("theme.id", "not-a-theme")).toBeNull();
    expect(validateSiteConfigValue("theme.id", "")).toBeNull();
  });
  it("url fields accept relative + http(s), reject javascript:/protocol-relative/control chars", () => {
    expect(validateSiteConfigValue("footer.badgeSrc", "/images/b.png")).toBe("/images/b.png");
    expect(validateSiteConfigValue("footer.webringUrl", "https://ring.example")).toBe("https://ring.example");
    expect(validateSiteConfigValue("footer.webringUrl", "")).toBe(""); // unset
    expect(validateSiteConfigValue("footer.webringUrl", "javascript:alert(1)")).toBeNull();
    expect(validateSiteConfigValue("footer.badgeSrc", "//evil.example/x")).toBeNull();
    expect(validateSiteConfigValue("site.name", "a\nb")).toBeNull(); // control char
  });
});

describe("applySiteConfig (#59 — shared by admin panel + setup wizard)", () => {
  it("upserts valid overrides + deletes null ones, then invalidates the cache", async () => {
    // Warm the cache, then apply → the next read must re-hit the DB.
    await getRuntimeSiteConfig();
    expect(prisma.siteSetting.findMany).toHaveBeenCalledTimes(1);
    const r = await applySiteConfig({ "feed.public": "true", "nav.about": null });
    expect(r).toEqual({ ok: true });
    expect(prisma.siteSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "feed.public" }, update: { value: "true" } }),
    );
    expect(prisma.siteSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "nav.about" } });
    await getRuntimeSiteConfig();
    expect(prisma.siteSetting.findMany).toHaveBeenCalledTimes(2); // cache was invalidated
  });

  it("rejects an unknown key, a non-string value, an invalid value, and an empty/oversized payload — writing nothing", async () => {
    expect((await applySiteConfig({ "nope.key": "x" })).ok).toBe(false);
    expect((await applySiteConfig({ "landing.mode": "maybe" })).ok).toBe(false);
    expect((await applySiteConfig({ "site.name": 5 })).ok).toBe(false);
    expect((await applySiteConfig({})).ok).toBe(false);
    expect((await applySiteConfig(null)).ok).toBe(false);
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalled();
    expect(prisma.siteSetting.deleteMany).not.toHaveBeenCalled();
  });
});

describe("buildNavLinks (#59)", () => {
  it("hides a section when its nav toggle is off", async () => {
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(rows({ "nav.journal": "false" }) as never);
    const links = buildNavLinks(await getRuntimeSiteConfig());
    expect(links.some((l) => l.href === "/journal")).toBe(false);
    expect(links.some((l) => l.href === "/articles")).toBe(true);
  });

  it("shows the Fediverse link only when public feed is on", async () => {
    invalidateSiteConfigCache();
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue([] as never);
    expect(buildNavLinks(await getRuntimeSiteConfig()).some((l) => l.href === "/fediverse")).toBe(false);
    invalidateSiteConfigCache();
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(rows({ "feed.public": "true" }) as never);
    expect(buildNavLinks(await getRuntimeSiteConfig()).some((l) => l.href === "/fediverse")).toBe(true);
  });

  it("shows the Download link only when the macOS app is enabled (#241)", async () => {
    invalidateSiteConfigCache();
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue([] as never);
    expect(buildNavLinks(await getRuntimeSiteConfig()).some((l) => l.href === "/download")).toBe(false);
    invalidateSiteConfigCache();
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(rows({ "download.macos.enabled": "true" }) as never);
    expect(buildNavLinks(await getRuntimeSiteConfig()).some((l) => l.href === "/download")).toBe(true);
  });
});
