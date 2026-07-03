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

import { publishPost } from "@/lib/publish-post";

const post = {
  id: "p1",
  slug: "hello",
  content: "hi there",
  publishedAt: new Date("2026-01-02T00:00:00Z"),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  deliverFollowers.mockResolvedValue(undefined);
  bsky.mockResolvedValue({ success: true, uri: "at://x" });
  threads.mockResolvedValue({ success: true, id: "t1" });
  buildObj.mockReturnValue({ type: "Note", id: "https://demo.example/post/hello" });
});

describe("publishPost", () => {
  it("federates a Create (with the built object) to followers", async () => {
    await publishPost(post);
    expect(deliverFollowers).toHaveBeenCalledTimes(1);
    const activity = deliverFollowers.mock.calls[0][0] as { type: string; id: string; object: unknown };
    expect(activity).toMatchObject({ type: "Create", id: "https://demo.example/ap/create/p1" });
    expect(activity.object).toEqual({ type: "Note", id: "https://demo.example/post/hello" });
  });

  it("crossposts to Bluesky + Threads with the content + post URL", async () => {
    await publishPost(post);
    expect(bsky).toHaveBeenCalledWith("hi there", "https://demo.example/post/hello");
    expect(threads).toHaveBeenCalledWith("hi there", "https://demo.example/post/hello");
  });

  it("is best-effort — a federation failure doesn't block crossposts or throw", async () => {
    deliverFollowers.mockRejectedValue(new Error("boom"));
    await expect(publishPost(post)).resolves.toBeUndefined();
    expect(bsky).toHaveBeenCalled();
  });
});
