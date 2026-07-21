import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { siteSettings: { findUnique: vi.fn() } } }));
vi.mock("@/../site.config", () => ({
  siteConfig: {
    authorName: "Env Name", authorBio: "env bio", authorTagline: "env tag",
    actorSummary: "env summary", avatarPath: "/images/avatar.png", bannerPath: "/images/banner.webp",
  },
}));

import { getRuntimeProfile, invalidateProfileCache } from "@/lib/site-profile";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  invalidateProfileCache();
  vi.mocked(prisma.siteSettings.findUnique).mockResolvedValue(null as never);
});

describe("getRuntimeProfile (#201)", () => {
  it("returns env defaults when no SiteSettings row exists", async () => {
    expect(await getRuntimeProfile()).toEqual({
      authorName: "Env Name", authorBio: "env bio", authorTagline: "env tag",
      actorSummary: "env summary", accentColor: "#3b82f6", themeAccents: {},
      avatarPath: "/images/avatar.png", bannerPath: "/images/banner.webp",
    });
  });

  it("overlays non-null SiteSettings columns on the env defaults", async () => {
    vi.mocked(prisma.siteSettings.findUnique).mockResolvedValue({
      authorName: "DB Name", authorBio: null, authorTagline: null,
      actorSummary: null, accentColor: "#ff0000", themeAccents: null,
      avatarPath: "/uploads/2026/07/me.jpg", bannerPath: null,
    } as never);
    const p = await getRuntimeProfile();
    expect(p.authorName).toBe("DB Name"); // overridden
    expect(p.authorBio).toBe("env bio"); // null → env default
    expect(p.accentColor).toBe("#ff0000");
    expect(p.themeAccents).toEqual({}); // null Json → {}
    expect(p.avatarPath).toBe("/uploads/2026/07/me.jpg");
    expect(p.bannerPath).toBe("/images/banner.webp"); // null → env default
  });

  it("an EMPTY-STRING avatar/banner falls back to the built-in default (#59 revert-to-default)", async () => {
    // This is the read contract the admin panel's "Revert to default" relies on:
    // it writes "" rather than pinning the literal default path, so the site
    // keeps tracking whatever the built-in default is.
    vi.mocked(prisma.siteSettings.findUnique).mockResolvedValue({
      authorName: null, authorBio: null, authorTagline: null, actorSummary: null,
      accentColor: null, themeAccents: null, avatarPath: "", bannerPath: "",
    } as never);
    const p = await getRuntimeProfile();
    expect(p.avatarPath).toBe("/images/avatar.png");
    expect(p.bannerPath).toBe("/images/banner.webp");
  });

  it("parses per-theme accents from the row, dropping junk entries (#276)", async () => {
    vi.mocked(prisma.siteSettings.findUnique).mockResolvedValue({
      authorName: null, authorBio: null, authorTagline: null, actorSummary: null,
      accentColor: null, avatarPath: null, bannerPath: null,
      themeAccents: { editorial: "#22C55E", default: "not-a-hex", bad: 123 },
    } as never);
    expect((await getRuntimeProfile()).themeAccents).toEqual({ editorial: "#22c55e" });
  });

  it("caches for a minute; invalidation forces a re-read", async () => {
    await getRuntimeProfile();
    await getRuntimeProfile();
    expect(prisma.siteSettings.findUnique).toHaveBeenCalledTimes(1);
    invalidateProfileCache();
    await getRuntimeProfile();
    expect(prisma.siteSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it("falls back to env defaults (uncached) when the DB is unreachable", async () => {
    vi.mocked(prisma.siteSettings.findUnique).mockRejectedValue(new Error("db down"));
    expect((await getRuntimeProfile()).authorName).toBe("Env Name");
    vi.mocked(prisma.siteSettings.findUnique).mockResolvedValue({ authorName: "Back" } as never);
    expect((await getRuntimeProfile()).authorName).toBe("Back"); // failure wasn't cached
  });
});
