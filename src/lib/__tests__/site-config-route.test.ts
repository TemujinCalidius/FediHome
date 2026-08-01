import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin, verifyOrigin } = vi.hoisted(() => ({ verifyAdmin: vi.fn(), verifyOrigin: vi.fn() }));
vi.mock("@/lib/auth", () => ({ verifyAdmin, verifyOrigin }));
vi.mock("@/lib/db", () => ({
  prisma: { siteSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock("@/lib/site-settings", async (orig) => {
  // Keep the real validation constants; stub the DB-touching getters.
  const actual = await orig<typeof import("@/lib/site-settings")>();
  return {
    ...actual,
    getRuntimeSiteConfig: vi.fn().mockResolvedValue({ name: "x", analytics: { siteId: "", embedId: "" } }),
    invalidateSiteConfigCache: vi.fn(),
    siteConfigDefaults: actual.siteConfigDefaults,
  };
});

const { checkUploadsDir } = vi.hoisted(() => ({ checkUploadsDir: vi.fn() }));
vi.mock("@/lib/uploads-dir", async (orig) => {
  const actual = await orig<typeof import("@/lib/uploads-dir")>();
  return { ...actual, checkUploadsDir, invalidateUploadsDirCache: vi.fn() };
});

import { GET, POST } from "@/app/api/admin/site-config/route";
import { prisma } from "@/lib/db";

function postReq(body: unknown): NextRequest {
  return new Request("https://x/api/admin/site-config", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
const getReq = () => new Request("https://x/api/admin/site-config") as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  verifyAdmin.mockResolvedValue(true);
  verifyOrigin.mockReturnValue(true);
  vi.mocked(prisma.siteSetting.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.siteSetting.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.siteSetting.deleteMany).mockResolvedValue({ count: 1 } as never);
});

describe("/api/admin/site-config (#59)", () => {
  it("GET requires admin", async () => {
    verifyAdmin.mockResolvedValue(false);
    expect((await GET(getReq())).status).toBe(401);
  });

  it("POST is CSRF-gated then admin-gated (cookie surface, no bearer)", async () => {
    verifyOrigin.mockReturnValue(false);
    expect((await POST(postReq({ settings: { "site.name": "x" } }))).status).toBe(403);
    verifyOrigin.mockReturnValue(true);
    verifyAdmin.mockResolvedValue(false);
    expect((await POST(postReq({ settings: { "site.name": "x" } }))).status).toBe(401);
  });

  it("rejects unknown keys + invalid values without writing", async () => {
    expect((await POST(postReq({ settings: { "site.evil": "x" } }))).status).toBe(400);
    expect((await POST(postReq({ settings: { "landing.mode": "maybe" } }))).status).toBe(400); // bool
    expect((await POST(postReq({ settings: { "landing.repoUrl": "javascript:alert(1)" } }))).status).toBe(400); // url
    expect((await POST(postReq({ settings: { "site.name": "line1\nline2" } }))).status).toBe(400); // control char
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalled();
  });

  it("accepts a valid mix, upserts overrides and deletes null ones (revert)", async () => {
    const res = await POST(postReq({ settings: {
      "site.name": "My Site",
      "landing.mode": "true",
      "footer.webringUrl": "https://ring.example",
      "footer.badgeSrc": "/images/badge.png",
      "nav.about": null,
    } }));
    expect(res.status).toBe(200);
    expect(prisma.siteSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: "site.name" }, update: { value: "My Site" },
    }));
    expect(prisma.siteSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "nav.about" } });
    // (Cache invalidation is applySiteConfig's job, covered in site-settings.test.ts.)
  });

  it("allows an empty string to clear a url/text field", async () => {
    expect((await POST(postReq({ settings: { "footer.fundingUrl": "" } }))).status).toBe(200);
  });
});

describe("uploads directory durability gate (#387)", () => {
  const save = (extra: Record<string, unknown> = {}) =>
    POST(postReq({ settings: { "storage.uploadsDir": "/app/data" }, ...extra }));

  it("saves without ceremony when the path is durable", async () => {
    checkUploadsDir.mockResolvedValue({ ok: true, path: "/data/uploads" });
    expect((await save()).status).toBe(200);
  });

  it("409s rather than 400s when the path works but isn't durable", async () => {
    // 400 would read as "you got it wrong". The path is fine — we want the
    // operator to say they meant it.
    checkUploadsDir.mockResolvedValue({ ok: true, path: "/app/data", ephemeral: "gone on rebuild" });
    const res = await save();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("gone on rebuild");
    expect(body.confirm).toBe("acknowledgeEphemeral");
  });

  it("does not write the setting when it 409s", async () => {
    // The whole point: the save must not half-apply while asking.
    checkUploadsDir.mockResolvedValue({ ok: true, path: "/app/data", ephemeral: "gone on rebuild" });
    await save();
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalled();
  });

  it("proceeds once the operator acknowledges", async () => {
    // It asks, it does not refuse — only the operator knows their deployment.
    checkUploadsDir.mockResolvedValue({ ok: true, path: "/app/data", ephemeral: "gone on rebuild" });
    expect((await save({ acknowledgeEphemeral: true })).status).toBe(200);
  });

  it("is not satisfied by a truthy non-true acknowledgement", async () => {
    // Strict === true, so a stray "false" string or 1 from a hand-rolled client
    // can't wave it through.
    checkUploadsDir.mockResolvedValue({ ok: true, path: "/app/data", ephemeral: "gone on rebuild" });
    expect((await save({ acknowledgeEphemeral: "false" })).status).toBe(409);
    expect((await save({ acknowledgeEphemeral: 1 })).status).toBe(409);
  });

  it("still 400s an unusable path, acknowledged or not", async () => {
    // The acknowledgement covers durability only. It must not become a way to
    // bypass the existence and writability probes.
    checkUploadsDir.mockResolvedValue({ ok: false, error: "not writable" });
    expect((await save({ acknowledgeEphemeral: true })).status).toBe(400);
  });
});
