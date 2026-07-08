import { describe, it, expect, vi, beforeEach } from "vitest";

const { crosspostToBluesky, crosspostReplyToBluesky, crosspostToThreads } = vi.hoisted(() => ({
  crosspostToBluesky: vi.fn(),
  crosspostReplyToBluesky: vi.fn(),
  crosspostToThreads: vi.fn(),
}));
vi.mock("@/lib/crosspost", () => ({ crosspostToBluesky, crosspostReplyToBluesky, crosspostToThreads }));
vi.mock("@/lib/db", () => ({
  prisma: {
    failedCrosspost: { upsert: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    post: { update: vi.fn() },
  },
}));

import { retryFailedCrossposts, enqueueFailedCrosspost } from "@/lib/crosspost-retry";
import { prisma } from "@/lib/db";

const NOW = new Date("2026-07-08T12:00:00.000Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: "c1", postId: "p1", platform: "bluesky",
  payload: JSON.stringify({ text: "hi", url: "https://x/post/hi" }),
  attempts: 1, nextRetryAt: new Date("2026-07-08T11:58:00.000Z"), failedAt: null,
  createdAt: new Date("2026-07-08T11:55:00.000Z"), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.failedCrosspost.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.failedCrosspost.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.failedCrosspost.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.failedCrosspost.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.post.update).mockResolvedValue({} as never);
  crosspostToBluesky.mockResolvedValue({ success: true, uri: "at://done" });
  crosspostReplyToBluesky.mockResolvedValue({ success: true, uri: "at://reply" });
  crosspostToThreads.mockResolvedValue({ success: true, id: "th1" });
});

describe("enqueueFailedCrosspost (#225)", () => {
  it("upserts an idempotent row per (postId, platform) with the serialized payload", async () => {
    await enqueueFailedCrosspost("p1", "bluesky", { text: "hi", url: "u", replyTo: "at://parent" }, "GOAWAY");
    const arg = vi.mocked(prisma.failedCrosspost.upsert).mock.calls[0][0];
    expect(arg.where).toEqual({ postId_platform: { postId: "p1", platform: "bluesky" } });
    expect(JSON.parse((arg.create as { payload: string }).payload)).toEqual({ text: "hi", url: "u", replyTo: "at://parent" });
    expect(arg.update).toMatchObject({ attempts: { increment: 1 } });
  });

  it("never throws if the upsert fails", async () => {
    vi.mocked(prisma.failedCrosspost.upsert).mockRejectedValue(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(enqueueFailedCrosspost("p1", "threads", { text: "x" }, "e")).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});

describe("retryFailedCrossposts (#225)", () => {
  it("re-sends a Bluesky crosspost, writes blueskyUri, deletes the row on success", async () => {
    vi.mocked(prisma.failedCrosspost.findMany).mockResolvedValueOnce([row()] as never);
    const r = await retryFailedCrossposts(NOW);
    expect(crosspostToBluesky).toHaveBeenCalledWith("hi", "https://x/post/hi", undefined, undefined);
    expect(prisma.post.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { blueskyUri: "at://done" } });
    expect(prisma.failedCrosspost.deleteMany).toHaveBeenCalledWith({ where: { id: "c1" } });
    expect(r.delivered).toBe(1);
  });

  it("uses the reply API + reply parent when the payload has replyTo", async () => {
    vi.mocked(prisma.failedCrosspost.findMany).mockResolvedValueOnce([
      row({ payload: JSON.stringify({ text: "re", url: "u", replyTo: "at://parent" }) }),
    ] as never);
    await retryFailedCrossposts(NOW);
    expect(crosspostReplyToBluesky).toHaveBeenCalledWith("re", "at://parent", "u", undefined, undefined);
    expect(crosspostToBluesky).not.toHaveBeenCalled();
  });

  it("re-sends a Threads crosspost + writes threadsPostId on success", async () => {
    vi.mocked(prisma.failedCrosspost.findMany).mockResolvedValueOnce([
      row({ id: "c2", platform: "threads", payload: JSON.stringify({ text: "t", url: "u" }) }),
    ] as never);
    await retryFailedCrossposts(NOW);
    expect(crosspostToThreads).toHaveBeenCalledWith("t", "u");
    expect(prisma.post.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { threadsPostId: "th1" } });
  });

  it("claims atomically (CAS on nextRetryAt); a lost race re-attempts nothing", async () => {
    vi.mocked(prisma.failedCrosspost.findMany).mockResolvedValueOnce([row()] as never);
    vi.mocked(prisma.failedCrosspost.updateMany).mockResolvedValue({ count: 0 } as never);
    const r = await retryFailedCrossposts(NOW);
    expect(crosspostToBluesky).not.toHaveBeenCalled();
    expect(r.claimed).toBe(0);
    const claim = vi.mocked(prisma.failedCrosspost.updateMany).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(claim.where).toEqual({ id: "c1", nextRetryAt: row().nextRetryAt });
  });

  it("reschedules with the next backoff step on failure (attempts 1→2 → 10 min)", async () => {
    vi.mocked(prisma.failedCrosspost.findMany).mockResolvedValueOnce([row({ attempts: 1 })] as never);
    crosspostToBluesky.mockResolvedValue({ success: false, error: "still down" });
    await retryFailedCrossposts(NOW);
    const reschedule = vi.mocked(prisma.failedCrosspost.updateMany).mock.calls
      .map((c) => c[0].data as Record<string, unknown>).find((d) => d.attempts === 2);
    expect(reschedule).toBeTruthy();
    expect(reschedule!.failedAt).toBeUndefined();
    expect((reschedule!.nextRetryAt as Date).getTime()).toBe(NOW.getTime() + 10 * 60_000);
  });

  it("still reschedules at attempts 4→5 (24h) — brackets the give-up boundary from below", async () => {
    vi.mocked(prisma.failedCrosspost.findMany).mockResolvedValueOnce([row({ attempts: 4 })] as never);
    crosspostToBluesky.mockResolvedValue({ success: false, error: "down" });
    const r = await retryFailedCrossposts(NOW);
    const data = vi.mocked(prisma.failedCrosspost.updateMany).mock.calls
      .map((c) => c[0].data as Record<string, unknown>).find((d) => d.attempts === 5);
    expect(data!.failedAt).toBeUndefined();
    expect((data!.nextRetryAt as Date).getTime()).toBe(NOW.getTime() + 1440 * 60_000);
    expect(r.gaveUp).toBe(0);
  });

  it("gives up (failedAt) after the max attempts", async () => {
    vi.mocked(prisma.failedCrosspost.findMany).mockResolvedValueOnce([row({ attempts: 5 })] as never);
    crosspostToBluesky.mockResolvedValue({ success: false, error: "gone" });
    const r = await retryFailedCrossposts(NOW);
    const terminal = vi.mocked(prisma.failedCrosspost.updateMany).mock.calls
      .map((c) => c[0].data as Record<string, unknown>).find((d) => d.failedAt);
    expect(terminal!.attempts).toBe(6);
    expect(r.gaveUp).toBe(1);
  });

  it("prunes ONLY terminal rows by failedAt age — never a pending row", async () => {
    await retryFailedCrossposts(NOW);
    const where = vi.mocked(prisma.failedCrosspost.deleteMany).mock.calls.at(-1)![0]?.where as { failedAt: { lt: Date } };
    expect(where.failedAt.lt).toBeInstanceOf(Date);
    expect(where).not.toHaveProperty("createdAt");
  });
});
