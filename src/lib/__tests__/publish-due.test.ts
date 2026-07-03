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
    post: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    photo: { updateMany: vi.fn() },
    video: { updateMany: vi.fn() },
    audio: { updateMany: vi.fn() },
  },
}));

import { publishDueScheduledPosts } from "@/lib/publish-post";
import { prisma } from "@/lib/db";

const post = (over: Record<string, unknown> = {}) => ({
  id: "p1", slug: "hello", content: "hi", publishedAt: new Date("2026-01-01"),
  blueskyUri: null, threadsPostId: null, federatedAt: null, ...over,
});

// The sweep queries twice: due-unpublished first, then the stuck-retry set.
function mockSweeps(due: unknown[], stuck: unknown[] = []) {
  vi.mocked(prisma.post.findMany)
    .mockResolvedValueOnce(due as never)
    .mockResolvedValueOnce(stuck as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  deliverFollowers.mockResolvedValue(undefined);
  bsky.mockResolvedValue({ success: true, uri: "at://did:plc:x/app.bsky.feed.post/1" });
  threads.mockResolvedValue({ success: true, id: "th1" });
  buildObj.mockReturnValue({ type: "Note" });
  vi.mocked(prisma.post.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.post.update).mockResolvedValue({} as never);
  // publishPost re-reads the crosspost markers; default: nothing done yet.
  vi.mocked(prisma.post.findUnique).mockResolvedValue({ blueskyUri: null, threadsPostId: null } as never);
  vi.mocked(prisma.photo.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.video.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.audio.updateMany).mockResolvedValue({ count: 0 } as never);
});

describe("publishDueScheduledPosts — due sweep", () => {
  it("publishes each due post and queries only unpublished, past-due rows", async () => {
    mockSweeps([post({ id: "p1", slug: "a" }), post({ id: "p2", slug: "b" })]);
    const n = await publishDueScheduledPosts(new Date("2026-06-01T00:00:00Z"));
    expect(n).toBe(2);
    const where = vi.mocked(prisma.post.findMany).mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where.published).toBe(false);
    expect(where.scheduledFor).toHaveProperty("lte");
    expect(deliverFollowers).toHaveBeenCalledTimes(2); // publishPost ran per post
  });

  it("claims via a compare-and-swap on published:false — the WHERE is the atomicity", async () => {
    mockSweeps([post()]);
    await publishDueScheduledPosts();
    const claim = vi.mocked(prisma.post.updateMany).mock.calls[0][0] as { where: unknown; data: unknown };
    expect(claim.where).toEqual({ id: "p1", published: false });
    expect(claim.data).toEqual({ published: true });
  });

  it("skips a post already claimed by a concurrent run (atomic claim)", async () => {
    mockSweeps([post()]);
    vi.mocked(prisma.post.updateMany).mockResolvedValue({ count: 0 } as never);
    const n = await publishDueScheduledPosts();
    expect(n).toBe(0);
    expect(deliverFollowers).not.toHaveBeenCalled();
  });

  it("returns 0 when nothing is due", async () => {
    mockSweeps([]);
    expect(await publishDueScheduledPosts()).toBe(0);
  });

  it("marks federatedAt only AFTER delivery ran (crash before it → retry eligible)", async () => {
    mockSweeps([post()]);
    await publishDueScheduledPosts();
    const calls = vi.mocked(prisma.post.updateMany).mock.calls;
    const markIdx = calls.findIndex((c) => (c[0]?.data as Record<string, unknown>)?.federatedAt instanceof Date);
    expect(markIdx).toBeGreaterThan(-1);
    // Ordering pin: the delivery happened before the federatedAt mark was written.
    const markOrder = vi.mocked(prisma.post.updateMany).mock.invocationCallOrder[markIdx];
    const deliverOrder = deliverFollowers.mock.invocationCallOrder[0];
    expect(deliverOrder).toBeLessThan(markOrder);
  });

  it("persists blueskyUri + threadsPostId from the crossposts (reply-sync + retry markers)", async () => {
    mockSweeps([post()]);
    await publishDueScheduledPosts();
    const updates = vi.mocked(prisma.post.update).mock.calls.map((c) => c[0]?.data);
    expect(updates).toContainEqual({ blueskyUri: "at://did:plc:x/app.bsky.feed.post/1" });
    expect(updates).toContainEqual({ threadsPostId: "th1" });
  });
});

describe("publishDueScheduledPosts — retry sweep (#195)", () => {
  it("retries a claimed-but-never-federated scheduled post after a QUIET grace period (updatedAt-anchored)", async () => {
    mockSweeps([], [post({ id: "p9", slug: "stuck", federatedAt: null })]);
    const n = await publishDueScheduledPosts(new Date("2026-06-01T12:00:00Z"));
    expect(n).toBe(1);
    expect(deliverFollowers).toHaveBeenCalledTimes(1);
    const where = vi.mocked(prisma.post.findMany).mock.calls[1][0]?.where as Record<string, unknown>;
    expect(where.published).toBe(true);
    expect(where.federatedAt).toBeNull();
    // scheduledFor only discriminates "was a scheduled post"; the grace is on
    // updatedAt so a post claimed late (downtime) still gets its quiet period.
    expect(where.scheduledFor).toEqual({ not: null });
    const upd = where.updatedAt as { lte: Date };
    expect(upd.lte.getTime()).toBe(new Date("2026-06-01T11:50:00Z").getTime()); // now - 10 min
  });

  it("claims the retry atomically via a federatedAt:null compare-and-swap", async () => {
    mockSweeps([], [post({ id: "p9", slug: "stuck" })]);
    await publishDueScheduledPosts();
    const claim = vi.mocked(prisma.post.updateMany).mock.calls[0][0] as { where: unknown; data: Record<string, unknown> };
    expect(claim.where).toEqual({ id: "p9", federatedAt: null });
    expect(claim.data.federatedAt).toBeInstanceOf(Date);
  });

  it("a lost retry-claim race means no re-delivery", async () => {
    mockSweeps([], [post({ id: "p9", slug: "stuck" })]);
    vi.mocked(prisma.post.updateMany).mockResolvedValue({ count: 0 } as never);
    const n = await publishDueScheduledPosts();
    expect(n).toBe(0);
    expect(deliverFollowers).not.toHaveBeenCalled();
  });

  it("a retry skips crossposts that already succeeded (marker-guarded, no double-post)", async () => {
    mockSweeps([], [post({ id: "p9", slug: "stuck" })]);
    // publishPost trusts the FRESH DB markers, not the sweep's snapshot.
    vi.mocked(prisma.post.findUnique).mockResolvedValue({ blueskyUri: "at://already", threadsPostId: "th-done" } as never);
    await publishDueScheduledPosts();
    expect(deliverFollowers).toHaveBeenCalledTimes(1); // AP redelivery is safe (deduped remotely)
    expect(bsky).not.toHaveBeenCalled();
    expect(threads).not.toHaveBeenCalled();
  });
});
