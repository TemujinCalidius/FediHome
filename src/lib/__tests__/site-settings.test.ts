import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { siteSetting: { findMany: vi.fn() } } }));
vi.mock("@/../site.config", () => ({
  siteConfig: {
    name: "Env Site", description: "env desc",
    landingMode: false, landingHeadline: "env headline", landingSubhead: "env subhead", repoUrl: "https://env/repo",
    publicFeed: false, publicFeedTitle: "env feed", hideSocialGraph: false,
    nav: { showJournal: true, showArticles: true, showPhotography: true, showVideos: true, showAudio: true, showAbout: true },
    footer: { webringUrl: "", webringLabel: "Webring", badgeSrc: "", badgeHref: "", badgeAlt: "Badge", fundingUrl: "", fundingLabel: "Support" },
  },
}));

import { getRuntimeSiteConfig, invalidateSiteConfigCache, siteConfigDefaults } from "@/lib/site-settings";
import { buildNavLinks } from "@/lib/nav";
import { prisma } from "@/lib/db";

const rows = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSiteConfigCache();
  vi.mocked(prisma.siteSetting.findMany).mockResolvedValue([] as never);
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
});
