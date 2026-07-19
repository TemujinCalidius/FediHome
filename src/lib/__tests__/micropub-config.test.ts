import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// GET /api/micropub?q=config exposes the resolved gallery categories so API
// clients (e.g. the native apps) share the SAME source of truth as the web
// galleries instead of deriving categories by paging posts (#284, reopened).

const { getRuntimeSiteConfig } = vi.hoisted(() => ({ getRuntimeSiteConfig: vi.fn() }));
vi.mock("@/lib/site-settings", () => ({ getRuntimeSiteConfig }));
vi.mock("@/lib/auth", () => ({ verifyMicropubToken: vi.fn(), hasScope: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordTokenUse: vi.fn() }));
vi.mock("@/lib/publish-post", () => ({ publishPost: vi.fn() }));
vi.mock("@/lib/delete-post", () => ({ deletePostWithFederation: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    photo: { findMany: vi.fn() },
    video: { findMany: vi.fn() },
    audio: { findMany: vi.fn() },
    post: { findUnique: vi.fn() },
  },
}));

import { GET } from "@/app/api/micropub/route";
import { prisma } from "@/lib/db";

const configReq = () => new NextRequest("https://x/api/micropub?q=config");
const rows = (...cats: string[]) => cats.map((category) => ({ category }));

beforeEach(() => {
  vi.clearAllMocks();
  getRuntimeSiteConfig.mockResolvedValue({
    categories: {
      photos: ["wildlife", "general"],
      videos: ["general", "vlog"],
      audio: ["general", "music"],
    },
  });
  vi.mocked(prisma.photo.findMany).mockResolvedValue(rows("wildlife", "street") as never); // "street" only in DB
  vi.mocked(prisma.video.findMany).mockResolvedValue(rows("general") as never);
  vi.mocked(prisma.audio.findMany).mockResolvedValue(rows("general") as never);
});

describe("Micropub q=config mediaCategories (#284)", () => {
  it("returns the resolved gallery categories as structured {slug,label}", async () => {
    const body = await (await GET(configReq())).json();
    // post-type list is untouched and distinct from the gallery lists
    expect(body.categories).toEqual(["journal", "note", "article", "photo"]);
    expect(body.mediaCategories.photos).toEqual([
      { slug: "wildlife", label: "Wildlife" },
      { slug: "general", label: "General" },
      { slug: "street", label: "Street" }, // in-use extra, appended (orphan-safe union)
    ]);
    expect(body.mediaCategories.videos).toEqual([
      { slug: "general", label: "General" },
      { slug: "vlog", label: "Vlog" },
    ]);
  });

  it("only counts published media (queries filter published:true)", async () => {
    await GET(configReq());
    for (const m of [prisma.photo.findMany, prisma.video.findMany, prisma.audio.findMany]) {
      expect(m).toHaveBeenCalledWith(
        expect.objectContaining({ where: { published: true }, distinct: ["category"] }),
      );
    }
  });

  it("isolates a per-media DB failure — the failing kind degrades to its configured list (no 500), the others keep their in-use union", async () => {
    vi.mocked(prisma.photo.findMany).mockRejectedValue(new Error("db down"));
    vi.mocked(prisma.video.findMany).mockResolvedValue(rows("general", "tutorial") as never); // "tutorial" only in DB
    const res = await GET(configReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    // photos: its query failed → configured-only, and crucially not a 500
    expect(body.mediaCategories.photos).toEqual([
      { slug: "wildlife", label: "Wildlife" },
      { slug: "general", label: "General" },
    ]);
    // videos: unaffected by the photo failure → still surfaces the in-use extra
    expect(body.mediaCategories.videos).toEqual([
      { slug: "general", label: "General" },
      { slug: "vlog", label: "Vlog" },
      { slug: "tutorial", label: "Tutorial" },
    ]);
  });
});
