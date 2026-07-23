import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const { deliverToFollowers, getActorProfile, getRuntimeProfile, invalidateProfileCache } = vi.hoisted(() => ({
  deliverToFollowers: vi.fn(),
  getActorProfile: vi.fn(),
  getRuntimeProfile: vi.fn(),
  invalidateProfileCache: vi.fn(),
}));
vi.mock("@/lib/http-signatures", () => ({ deliverToFollowers }));
vi.mock("@/lib/federation", () => ({ getActorProfile }));
vi.mock("@/lib/site-profile", () => ({ getRuntimeProfile, invalidateProfileCache }));
vi.mock("@/lib/db", () => ({ prisma: { siteSettings: { upsert: vi.fn() } } }));

import { updateProfile } from "@/app/api/admin/_actions/profile";
import { prisma } from "@/lib/db";

// Identity resolves from the env through src/lib/identity (#326), not from a
// stubbed site.config — so set the real variable the accessor reads.
const OLD_SITE_URL = process.env.SITE_URL;
afterAll(() => {
  if (OLD_SITE_URL === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = OLD_SITE_URL;
});

beforeEach(() => {
  process.env.SITE_URL = "https://demo.example";
  vi.clearAllMocks();
  deliverToFollowers.mockResolvedValue(undefined);
  getActorProfile.mockResolvedValue({ type: "Person", name: "New" });
  getRuntimeProfile.mockResolvedValue({
    authorName: "New", authorBio: "b", authorTagline: "t", actorSummary: "s",
    accentColor: "#123456", themeAccents: {}, avatarPath: "/uploads/a.jpg", bannerPath: "/images/banner.webp",
  });
  vi.mocked(prisma.siteSettings.upsert).mockResolvedValue({} as never);
});

describe("updateProfile (#201)", () => {
  it("upserts only the provided fields, invalidates cache, federates an actor Update", async () => {
    const res = await updateProfile({ action: "update_profile", authorName: "New", accentColor: "#123456" });
    expect(res.status).toBe(200);
    const upsert = vi.mocked(prisma.siteSettings.upsert).mock.calls[0][0];
    expect(upsert.update).toEqual({ authorName: "New", accentColor: "#123456" });
    expect(upsert.where).toEqual({ id: "main" });
    expect(invalidateProfileCache).toHaveBeenCalled();
    const activity = deliverToFollowers.mock.calls[0][0] as { type: string; object: unknown };
    expect(activity.type).toBe("Update");
    expect(activity.object).toEqual({ type: "Person", name: "New" });
  });

  it("400 when no fields are provided", async () => {
    const res = await updateProfile({ action: "update_profile" });
    expect(res.status).toBe(400);
    expect(prisma.siteSettings.upsert).not.toHaveBeenCalled();
  });

  it("rejects an external avatar URL (SSRF/hotlink) and a path-traversal", async () => {
    expect((await updateProfile({ avatarPath: "https://evil.example/x.jpg" })).status).toBe(400);
    expect((await updateProfile({ avatarPath: "/uploads/../../etc/passwd" })).status).toBe(400);
    expect(prisma.siteSettings.upsert).not.toHaveBeenCalled();
  });

  it("clears avatar/banner back to the built-in default with \"\" or null (#59)", async () => {
    // "" is what "use the built-in default" means: site-profile reads
    // `row.avatarPath || base.avatarPath`, so an empty string reverts to
    // site.config's /images/avatar.png AND keeps tracking that default.
    await updateProfile({ avatarPath: "" });
    expect(vi.mocked(prisma.siteSettings.upsert).mock.calls[0][0].update).toEqual({ avatarPath: "" });

    vi.clearAllMocks();
    vi.mocked(prisma.siteSettings.upsert).mockResolvedValue({} as never);
    getActorProfile.mockResolvedValue({ type: "Person" });
    await updateProfile({ bannerPath: null });
    expect(vi.mocked(prisma.siteSettings.upsert).mock.calls[0][0].update).toEqual({ bannerPath: "" });
  });

  it("clearing an image still federates — it changes the actor document (#59)", async () => {
    await updateProfile({ avatarPath: "" });
    expect(deliverToFollowers).toHaveBeenCalledTimes(1);
  });

  it("does NOT federate for local-only fields, so a settings save can't spam followers (#59)", async () => {
    // The guard is `field in data` (presence, not a value diff), so the admin
    // panel must dirty-diff. These three are local display only.
    await updateProfile({ authorBio: "b", authorTagline: "t", accentColor: "#abcdef" });
    expect(prisma.siteSettings.upsert).toHaveBeenCalled();
    expect(deliverToFollowers).not.toHaveBeenCalled();
  });

  it("round-trips bio + summary, rejecting newlines and over-length values", async () => {
    await updateProfile({ authorBio: "Hello there", actorSummary: "A summary" });
    expect(vi.mocked(prisma.siteSettings.upsert).mock.calls[0][0].update).toEqual({
      authorBio: "Hello there", actorSummary: "A summary",
    });
    expect((await updateProfile({ authorBio: "line1\nline2" })).status).toBe(400);
    expect((await updateProfile({ actorSummary: "x".repeat(501) })).status).toBe(400);
  });

  it("accepts an uploaded path and strips our own origin prefix", async () => {
    await updateProfile({ avatarPath: "https://demo.example/uploads/2026/07/me.jpg" });
    expect(vi.mocked(prisma.siteSettings.upsert).mock.calls[0][0].update).toEqual({
      avatarPath: "/uploads/2026/07/me.jpg",
    });
  });

  it("rejects a non-hex accent color and control chars in text", async () => {
    expect((await updateProfile({ accentColor: "red" })).status).toBe(400);
    expect((await updateProfile({ authorName: "line1\nline2" })).status).toBe(400);
  });

  // #276 — per-theme accent + the federation guard.
  it("does NOT federate an actor Update for an accent-only save", async () => {
    const res = await updateProfile({ action: "update_profile", accentColor: "#abcdef" });
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.siteSettings.upsert).mock.calls[0][0].update).toEqual({ accentColor: "#abcdef" });
    expect(deliverToFollowers).not.toHaveBeenCalled(); // accent isn't in the actor doc
  });

  it("still federates when a federated field (name) changes", async () => {
    await updateProfile({ action: "update_profile", authorName: "Renamed" });
    expect(deliverToFollowers).toHaveBeenCalledTimes(1);
  });

  it("merges a per-theme accent override and does not federate", async () => {
    const res = await updateProfile({ action: "update_profile", themeAccents: { editorial: "#22C55E" } });
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.siteSettings.upsert).mock.calls[0][0].update).toEqual({
      themeAccents: { editorial: "#22c55e" }, // lowercased, merged onto {}
    });
    expect(deliverToFollowers).not.toHaveBeenCalled();
  });

  it("clears a per-theme accent (empty value → inherit) by removing the key", async () => {
    getRuntimeProfile.mockResolvedValue({
      authorName: "N", authorBio: "b", authorTagline: "t", actorSummary: "s",
      accentColor: "#123456", themeAccents: { editorial: "#22c55e" }, avatarPath: "/uploads/a.jpg", bannerPath: "/images/b.webp",
    });
    await updateProfile({ action: "update_profile", themeAccents: { editorial: "" } });
    expect(vi.mocked(prisma.siteSettings.upsert).mock.calls[0][0].update).toEqual({ themeAccents: {} });
  });

  it("rejects an unknown theme id and a non-hex per-theme value", async () => {
    expect((await updateProfile({ themeAccents: { "not-a-theme": "#22c55e" } })).status).toBe(400);
    expect((await updateProfile({ themeAccents: { editorial: "green" } })).status).toBe(400);
    expect(prisma.siteSettings.upsert).not.toHaveBeenCalled();
  });
});
