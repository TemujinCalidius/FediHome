import { describe, it, expect, vi, beforeEach } from "vitest";

const { getEffectiveSchedulerConfig } = vi.hoisted(() => ({ getEffectiveSchedulerConfig: vi.fn() }));
vi.mock("@/lib/scheduler-config", () => ({ getEffectiveSchedulerConfig }));
const { removeFediMediaFiles } = vi.hoisted(() => ({ removeFediMediaFiles: vi.fn() }));
vi.mock("@/lib/fedi-media", () => ({ removeFediMediaFiles }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediPost: { findMany: vi.fn(), deleteMany: vi.fn() },
    fediInteraction: { deleteMany: vi.fn() },
    fediFollower: { deleteMany: vi.fn() },
    fediFollowing: { deleteMany: vi.fn() },
    directMessage: { deleteMany: vi.fn() },
  },
}));

import { pruneStaleFediPosts } from "@/lib/fedi-retention";
import { prisma } from "@/lib/db";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const DAYS = 90;
const CUTOFF = new Date(NOW.getTime() - DAYS * 24 * 60 * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveSchedulerConfig.mockResolvedValue({
    retentionSweep: { enabled: true, intervalSec: 86_400, retentionDays: DAYS },
  });
  // Default: no owned posts (call 1) and no candidates (call 2).
  vi.mocked(prisma.fediPost.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.fediPost.deleteMany).mockResolvedValue({ count: 0 } as never);
  removeFediMediaFiles.mockResolvedValue(0);
});

describe("pruneStaleFediPosts (#240)", () => {
  it("targets ONLY remote posts older than the window (createdAt), and never touches own/interaction/follow/DM tables", async () => {
    vi.mocked(prisma.fediPost.findMany)
      .mockResolvedValueOnce([] as never) // owned keep-set query
      .mockResolvedValueOnce([{ id: "r1", mediaUrls: [], embedImage: null }] as never);
    vi.mocked(prisma.fediPost.deleteMany).mockResolvedValue({ count: 1 } as never);

    const r = await pruneStaleFediPosts(NOW);

    const candWhere = vi.mocked(prisma.fediPost.findMany).mock.calls[1][0]?.where as Record<string, unknown>;
    expect(candWhere.isOutgoing).toBe(false); // remote only
    expect(candWhere.createdAt).toEqual({ lt: CUTOFF }); // ingestion-time clock
    expect(prisma.fediPost.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["r1"] } } });
    expect(r.pruned).toBe(1);

    // The keep set is sacrosanct — these are never deleted from here.
    expect(prisma.fediInteraction.deleteMany).not.toHaveBeenCalled();
    expect(prisma.fediFollower.deleteMany).not.toHaveBeenCalled();
    expect(prisma.fediFollowing.deleteMany).not.toHaveBeenCalled();
    expect(prisma.directMessage.deleteMany).not.toHaveBeenCalled();
  });

  it("reads the keep-set from our own posts (isOutgoing:true) and spares threads we're in", async () => {
    vi.mocked(prisma.fediPost.findMany)
      .mockResolvedValueOnce([
        { apId: "https://me/p1", inReplyTo: "https://remote/parent", conversationId: "conv-1" },
      ] as never)
      .mockResolvedValueOnce([] as never);

    await pruneStaleFediPosts(NOW);

    const ownedWhere = vi.mocked(prisma.fediPost.findMany).mock.calls[0][0]?.where as Record<string, unknown>;
    expect(ownedWhere).toEqual({ isOutgoing: true }); // we only READ our own posts, never delete them

    const candWhere = vi.mocked(prisma.fediPost.findMany).mock.calls[1][0]?.where as Record<string, unknown>;
    // The remote post our reply replies to is spared by apId…
    expect(candWhere.apId).toEqual({ notIn: ["https://remote/parent"] });
    // …and threads we're part of are spared by conversationId (null rows still prunable),
    // including the thread rooted at our own post's apId.
    expect(candWhere.OR).toEqual([
      { conversationId: null },
      { conversationId: { notIn: expect.arrayContaining(["conv-1", "https://me/p1"]) } },
    ]);
  });

  it("reclaims cached media for pruned posts, deleting rows BEFORE unlinking files", async () => {
    vi.mocked(prisma.fediPost.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { id: "r1", mediaUrls: ["/uploads/fedi/2026/01/a.jpg"], embedImage: "/uploads/fedi/2026/01/og.jpg" },
      ] as never);
    vi.mocked(prisma.fediPost.deleteMany).mockResolvedValue({ count: 1 } as never);
    removeFediMediaFiles.mockResolvedValue(2);

    const r = await pruneStaleFediPosts(NOW);

    expect(removeFediMediaFiles).toHaveBeenCalledWith([
      "/uploads/fedi/2026/01/a.jpg",
      "/uploads/fedi/2026/01/og.jpg",
    ]);
    expect(r.filesRemoved).toBe(2);
    // Rows gone first, files after — a row pointing at a deleted file would 404.
    const delOrder = vi.mocked(prisma.fediPost.deleteMany).mock.invocationCallOrder[0];
    const unlinkOrder = removeFediMediaFiles.mock.invocationCallOrder[0];
    expect(delOrder).toBeLessThan(unlinkOrder);
  });

  it("prunes nothing when no remote post is past the window", async () => {
    const r = await pruneStaleFediPosts(NOW);
    expect(prisma.fediPost.deleteMany).not.toHaveBeenCalled();
    expect(removeFediMediaFiles).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 0, pruned: 0, filesRemoved: 0, capped: false });
  });

  it("honours the configured window (30d) when computing the cutoff", async () => {
    getEffectiveSchedulerConfig.mockResolvedValue({
      retentionSweep: { enabled: true, intervalSec: 86_400, retentionDays: 30 },
    });
    vi.mocked(prisma.fediPost.findMany).mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never);
    await pruneStaleFediPosts(NOW);
    const candWhere = vi.mocked(prisma.fediPost.findMany).mock.calls[1][0]?.where as Record<string, unknown>;
    expect(candWhere.createdAt).toEqual({ lt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000) });
  });
});
