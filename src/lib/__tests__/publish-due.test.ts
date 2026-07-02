import { describe, it, expect, vi, beforeEach } from "vitest";

const { deliverFollowers, bsky, threads, buildObj } = vi.hoisted(() => ({
  deliverFollowers: vi.fn(),
  bsky: vi.fn(),
  threads: vi.fn(),
  buildObj: vi.fn(),
}));
vi.mock("@/lib/http-signatures", () => ({ deliverToFollowers: deliverFollowers }));
vi.mock("@/lib/crosspost", () => ({ crosspostToBluesky: bsky, crosspostToThreads: threads }));
vi.mock("@/lib/ap-post", () => ({ buildPostObject: buildObj }));
vi.mock("@/lib/db", () => ({
  prisma: {
    post: { findMany: vi.fn(), updateMany: vi.fn() },
    photo: { updateMany: vi.fn() },
    video: { updateMany: vi.fn() },
    audio: { updateMany: vi.fn() },
  },
}));

import { publishDueScheduledPosts } from "@/lib/publish-post";
import { prisma } from "@/lib/db";

const post = (over: Record<string, unknown> = {}) => ({
  id: "p1", slug: "hello", content: "hi", publishedAt: new Date("2026-01-01"), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  deliverFollowers.mockResolvedValue(undefined);
  bsky.mockResolvedValue({ success: true });
  threads.mockResolvedValue({ success: true });
  buildObj.mockReturnValue({ type: "Note" });
  vi.mocked(prisma.post.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.photo.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.video.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.audio.updateMany).mockResolvedValue({ count: 0 } as never);
});

describe("publishDueScheduledPosts", () => {
  it("publishes each due post and queries only unpublished, past-due rows", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([post({ id: "p1", slug: "a" }), post({ id: "p2", slug: "b" })] as never);
    const n = await publishDueScheduledPosts(new Date("2026-06-01T00:00:00Z"));
    expect(n).toBe(2);
    const where = vi.mocked(prisma.post.findMany).mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where.published).toBe(false);
    expect(where.scheduledFor).toHaveProperty("lte");
    expect(deliverFollowers).toHaveBeenCalledTimes(2); // publishPost ran per post
  });

  it("skips a post already claimed by a concurrent run (atomic claim)", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([post()] as never);
    vi.mocked(prisma.post.updateMany).mockResolvedValue({ count: 0 } as never);
    const n = await publishDueScheduledPosts();
    expect(n).toBe(0);
    expect(deliverFollowers).not.toHaveBeenCalled();
  });

  it("returns 0 when nothing is due", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([] as never);
    expect(await publishDueScheduledPosts()).toBe(0);
  });
});
