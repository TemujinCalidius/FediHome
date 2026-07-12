import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

// #225: a compose-time crosspost that returns { success:false } (transient
// Bluesky/Threads blip — the fns never throw) must be LOGGED, not silently
// discarded. Drives the create path with each crosspost failing.
const {
  authenticateApiRequest, verifyOrigin, deliverToFollowers, deliverActivity,
  crosspostToBluesky, crosspostReplyToBluesky, crosspostToThreads, crosspostToDayOne,
  parseMentions, linkMentions, buildApMentionTags, collectMentionInboxes, imageAttachment, sanitizeHtml, buildMediaUpdate,
  enqueueFailedCrosspost,
} = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  verifyOrigin: vi.fn(),
  deliverToFollowers: vi.fn(),
  deliverActivity: vi.fn(),
  crosspostToBluesky: vi.fn(),
  crosspostReplyToBluesky: vi.fn(),
  crosspostToThreads: vi.fn(),
  crosspostToDayOne: vi.fn(),
  parseMentions: vi.fn(),
  linkMentions: vi.fn((s: string) => s),
  buildApMentionTags: vi.fn(() => []),
  collectMentionInboxes: vi.fn(() => []),
  imageAttachment: vi.fn(),
  sanitizeHtml: vi.fn((s: string) => s),
  buildMediaUpdate: vi.fn(() => ({})),
  enqueueFailedCrosspost: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest, verifyOrigin }));
vi.mock("@/lib/http-signatures", () => ({ deliverToFollowers, deliverActivity }));
vi.mock("@/lib/crosspost", () => ({ crosspostToBluesky, crosspostReplyToBluesky, crosspostToThreads, crosspostToDayOne }));
vi.mock("@/lib/crosspost-retry", () => ({ enqueueFailedCrosspost }));
vi.mock("@/lib/mentions", () => ({ parseMentions, linkMentions, buildApMentionTags, collectMentionInboxes }));
vi.mock("@/lib/ap-post", () => ({ imageAttachment }));
vi.mock("@/lib/sanitize", () => ({ sanitizeHtml }));
vi.mock("@/lib/post-media", () => ({ buildMediaUpdate }));
vi.mock("@/lib/db", () => ({ prisma: { post: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() } } }));

import { POST } from "@/app/api/compose/route";
import { prisma } from "@/lib/db";

function createReq(body: Record<string, unknown>): NextRequest {
  return new Request("https://x/api/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
const flush = () => new Promise((r) => setTimeout(r, 0)); // let fire-and-forget .then()s run

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  authenticateApiRequest.mockResolvedValue({ ok: true, via: "cookie", scope: "*" });
  verifyOrigin.mockReturnValue(true);
  parseMentions.mockResolvedValue({ fedi: [] });
  deliverToFollowers.mockResolvedValue(undefined);
  deliverActivity.mockResolvedValue(undefined);
  enqueueFailedCrosspost.mockResolvedValue(undefined);
  vi.mocked(prisma.post.create).mockResolvedValue({
    id: "p1", slug: "hi", apId: "https://x/post/hi",
    publishedAt: new Date("2026-07-08T00:00:00Z"), coverImage: null,
    photos: [], photoCaptions: [], videos: [], videoTitles: [], audioPaths: [], audioTitles: [],
  } as never);
  vi.mocked(prisma.post.update).mockResolvedValue({} as never);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("compose crosspost failure logging (#225)", () => {
  it("logs a Bluesky crosspost that returns success:false (was silently discarded)", async () => {
    crosspostToBluesky.mockResolvedValue({ success: false, error: "GOAWAY" });
    crosspostToThreads.mockResolvedValue({ success: true, id: "t" });
    crosspostToDayOne.mockResolvedValue({ success: true });
    await POST(createReq({ content: "hello" }));
    expect(errSpy).toHaveBeenCalledWith("Bluesky crosspost failed:", "GOAWAY");
    expect(prisma.post.update).not.toHaveBeenCalled(); // no blueskyUri written on failure
    // #225: also enqueued for retry so the blip self-heals.
    expect(enqueueFailedCrosspost).toHaveBeenCalledWith(
      "p1", "bluesky", expect.objectContaining({ text: expect.any(String), url: expect.any(String) }), "GOAWAY",
    );
  });

  it("writes blueskyUri (no error log) when Bluesky succeeds", async () => {
    crosspostToBluesky.mockResolvedValue({ success: true, uri: "at://x" });
    crosspostToThreads.mockResolvedValue({ success: true, id: "t" });
    crosspostToDayOne.mockResolvedValue({ success: true });
    await POST(createReq({ content: "hello" }));
    expect(prisma.post.update).toHaveBeenCalledWith(expect.objectContaining({ data: { blueskyUri: "at://x" } }));
    expect(errSpy).not.toHaveBeenCalledWith("Bluesky crosspost failed:", expect.anything());
  });

  it("logs Threads + DayOne crossposts that return success:false (were only .catch()'d)", async () => {
    crosspostToBluesky.mockResolvedValue({ success: true, uri: "at://x" });
    crosspostToThreads.mockResolvedValue({ success: false, error: "threads 500" });
    crosspostToDayOne.mockResolvedValue({ success: false, error: "dayone 500" });
    await POST(createReq({ content: "hello" }));
    await flush();
    expect(errSpy).toHaveBeenCalledWith("Threads crosspost failed:", "threads 500");
    expect(errSpy).toHaveBeenCalledWith("DayOne crosspost failed:", "dayone 500");
    // Threads enqueues for retry; Day One (local journal export) only logs.
    expect(enqueueFailedCrosspost).toHaveBeenCalledWith("p1", "threads", expect.objectContaining({ text: expect.any(String) }), "threads 500");
    expect(enqueueFailedCrosspost).not.toHaveBeenCalledWith("p1", "dayone", expect.anything(), expect.anything());
  });
});
