import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// #224: editing an UNPUBLISHED post (draft or not-yet-published scheduled) must
// NOT federate its content; editing a PUBLISHED post still federates the Update.
const {
  authenticateApiRequest, verifyOrigin, deliverToFollowers, deliverActivity,
  parseMentions, linkMentions, buildApMentionTags, collectMentionInboxes, imageAttachment, sanitizeHtml, buildMediaUpdate,
} = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  verifyOrigin: vi.fn(),
  deliverToFollowers: vi.fn(),
  deliverActivity: vi.fn(),
  parseMentions: vi.fn(),
  linkMentions: vi.fn((s: string) => s),
  buildApMentionTags: vi.fn(() => []),
  collectMentionInboxes: vi.fn(() => []),
  imageAttachment: vi.fn(),
  sanitizeHtml: vi.fn((s: string) => s),
  buildMediaUpdate: vi.fn(() => ({})),
}));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest, verifyOrigin }));
vi.mock("@/lib/http-signatures", () => ({ deliverToFollowers, deliverActivity }));
vi.mock("@/lib/mentions", () => ({ parseMentions, linkMentions, buildApMentionTags, collectMentionInboxes }));
vi.mock("@/lib/ap-post", () => ({ imageAttachment }));
vi.mock("@/lib/sanitize", () => ({ sanitizeHtml }));
vi.mock("@/lib/post-media", () => ({ buildMediaUpdate }));
vi.mock("@/lib/crosspost", () => ({
  crosspostToBluesky: vi.fn(), crosspostReplyToBluesky: vi.fn(), crosspostToThreads: vi.fn(), crosspostToDayOne: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { post: { findUnique: vi.fn(), update: vi.fn() } } }));

import { POST } from "@/app/api/compose/route";
import { prisma } from "@/lib/db";

function editReq(): NextRequest {
  return new Request("https://x/api/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ editingPostId: "p1", content: "edited body" }),
  }) as unknown as NextRequest;
}

const postRow = (published: boolean) => ({
  id: "p1", slug: "hello", apId: "https://x/post/hello", title: null,
  content: "old", category: "note", published,
  publishedAt: new Date("2026-07-01T00:00:00Z"), coverImage: null,
  photos: [], photoCaptions: [], videos: [], videoTitles: [], audioPaths: [], audioTitles: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  authenticateApiRequest.mockResolvedValue({ ok: true, via: "cookie", scope: "*" });
  verifyOrigin.mockReturnValue(true);
  parseMentions.mockResolvedValue({ fedi: [] });
  deliverToFollowers.mockResolvedValue(undefined);
  deliverActivity.mockResolvedValue(undefined);
});

describe("updatePostHandler federation gate (#224)", () => {
  it("does NOT federate an edit to a DRAFT / unpublished post", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(postRow(false) as never);
    vi.mocked(prisma.post.update).mockResolvedValue(postRow(false) as never);
    const res = await POST(editReq());
    expect(res.status).toBe(200);
    expect(prisma.post.update).toHaveBeenCalled(); // row IS updated (silently)
    expect(deliverToFollowers).not.toHaveBeenCalled(); // but nothing federated
    expect(deliverActivity).not.toHaveBeenCalled();
  });

  it("DOES federate an edit to a PUBLISHED post", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(postRow(true) as never);
    vi.mocked(prisma.post.update).mockResolvedValue(postRow(true) as never);
    const res = await POST(editReq());
    expect(res.status).toBe(200);
    expect(deliverToFollowers).toHaveBeenCalledTimes(1);
    const activity = deliverToFollowers.mock.calls[0][0] as { type: string };
    expect(activity.type).toBe("Update");
  });
});
