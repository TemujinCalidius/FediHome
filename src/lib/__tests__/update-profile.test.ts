import { describe, it, expect, vi, beforeEach } from "vitest";

const { deliverToFollowers, getActorProfile, getRuntimeProfile, invalidateProfileCache } = vi.hoisted(() => ({
  deliverToFollowers: vi.fn(),
  getActorProfile: vi.fn(),
  getRuntimeProfile: vi.fn(),
  invalidateProfileCache: vi.fn(),
}));
vi.mock("@/lib/http-signatures", () => ({ deliverToFollowers }));
vi.mock("@/lib/federation", () => ({ getActorProfile }));
vi.mock("@/lib/site-profile", () => ({ getRuntimeProfile, invalidateProfileCache }));
vi.mock("@/../site.config", () => ({ siteConfig: { url: "https://demo.example" } }));
vi.mock("@/lib/db", () => ({ prisma: { siteSettings: { upsert: vi.fn() } } }));

import { updateProfile } from "@/app/api/admin/_actions/profile";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  deliverToFollowers.mockResolvedValue(undefined);
  getActorProfile.mockResolvedValue({ type: "Person", name: "New" });
  getRuntimeProfile.mockResolvedValue({
    authorName: "New", authorBio: "b", authorTagline: "t", actorSummary: "s",
    accentColor: "#123456", avatarPath: "/uploads/a.jpg", bannerPath: "/images/banner.webp",
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
});
