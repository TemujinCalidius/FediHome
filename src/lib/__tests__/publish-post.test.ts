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
// publishPost persists crosspost markers — mock the DB so the unit test is
// hermetic (a real Prisma client here would connect to a live localhost pg).
vi.mock("@/lib/db", () => ({
  prisma: { post: { update: vi.fn(), findUnique: vi.fn() } },
}));

import { publishPost } from "@/lib/publish-post";
import { prisma } from "@/lib/db";

const post = {
  id: "p1",
  slug: "hello",
  content: "hi there",
  publishedAt: new Date("2026-01-02T00:00:00Z"),
  blueskyUri: null,
  threadsPostId: null,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  deliverFollowers.mockResolvedValue(undefined);
  bsky.mockResolvedValue({ success: true, uri: "at://x" });
  threads.mockResolvedValue({ success: true, id: "t1" });
  buildObj.mockReturnValue({ type: "Note", id: "https://demo.example/post/hello" });
  vi.mocked(prisma.post.update).mockResolvedValue({} as never);
  vi.mocked(prisma.post.findUnique).mockResolvedValue({ blueskyUri: null, threadsPostId: null } as never);
});

describe("publishPost", () => {
  it("federates a Create (with the built object) to followers", async () => {
    await publishPost(post);
    expect(deliverFollowers).toHaveBeenCalledTimes(1);
    const activity = deliverFollowers.mock.calls[0][0] as { type: string; id: string; object: unknown };
    expect(activity).toMatchObject({ type: "Create", id: "https://demo.example/ap/create/p1" });
    expect(activity.object).toEqual({ type: "Note", id: "https://demo.example/post/hello" });
  });

  it("crossposts to Bluesky + Threads and persists both markers", async () => {
    await publishPost(post);
    expect(bsky).toHaveBeenCalledWith("hi there", "https://demo.example/post/hello");
    expect(threads).toHaveBeenCalledWith("hi there", "https://demo.example/post/hello");
    const updates = vi.mocked(prisma.post.update).mock.calls.map((c) => c[0]?.data);
    expect(updates).toContainEqual({ blueskyUri: "at://x" });
    expect(updates).toContainEqual({ threadsPostId: "t1" });
  });

  it("re-reads the markers from the DB — a fresh marker beats the caller's stale snapshot", async () => {
    // Caller snapshot says "not crossposted", DB says Bluesky already happened.
    vi.mocked(prisma.post.findUnique).mockResolvedValue({ blueskyUri: "at://done", threadsPostId: null } as never);
    await publishPost(post);
    expect(bsky).not.toHaveBeenCalled();
    expect(threads).toHaveBeenCalled();
  });

  it("falls back to the snapshot markers when the re-read fails", async () => {
    vi.mocked(prisma.post.findUnique).mockRejectedValue(new Error("db down"));
    await publishPost({ ...(post as object), threadsPostId: "already" } as never);
    expect(bsky).toHaveBeenCalled(); // snapshot null → attempt
    expect(threads).not.toHaveBeenCalled(); // snapshot marker → skip
  });

  it("is best-effort — a federation failure doesn't block crossposts or throw", async () => {
    deliverFollowers.mockRejectedValue(new Error("boom"));
    await expect(publishPost(post)).resolves.toBeUndefined();
    expect(bsky).toHaveBeenCalled();
  });
});
