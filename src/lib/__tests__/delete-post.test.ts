import { describe, it, expect, vi, beforeEach } from "vitest";

const { deliver } = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/lib/http-signatures", () => ({ deliverToFollowers: deliver }));
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(),
    blueskyReply: { deleteMany: vi.fn() },
    guestComment: { deleteMany: vi.fn() },
    post: { delete: vi.fn() },
  },
}));

import { deletePostWithFederation } from "../delete-post";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockResolvedValue([] as never);
  deliver.mockResolvedValue(undefined);
});

describe("deletePostWithFederation (#16)", () => {
  it("deletes the post + BlueskyReply + GuestComment children in one transaction", async () => {
    await deletePostWithFederation({ id: "p1", apId: "https://x/post/p1", published: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown as unknown[];
    expect(ops).toHaveLength(3); // blueskyReply.deleteMany, guestComment.deleteMany, post.delete
    expect(prisma.blueskyReply.deleteMany).toHaveBeenCalledWith({ where: { postId: "p1" } });
    expect(prisma.guestComment.deleteMany).toHaveBeenCalledWith({ where: { postId: "p1" } });
    expect(prisma.post.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
  });

  it("federates an AP Delete for a published post with an apId", async () => {
    await deletePostWithFederation({ id: "p1", apId: "https://x/post/p1", published: true });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({ type: "Delete", object: "https://x/post/p1" });
  });

  it("does NOT federate an unpublished post or one without an apId", async () => {
    await deletePostWithFederation({ id: "p2", apId: null, published: true });
    await deletePostWithFederation({ id: "p3", apId: "https://x/post/p3", published: false });
    expect(deliver).not.toHaveBeenCalled();
    // ...but both were still deleted from the DB.
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
