import { describe, it, expect, vi, beforeEach } from "vitest";

const { deliverActivity } = vi.hoisted(() => ({ deliverActivity: vi.fn() }));
vi.mock("@/lib/http-signatures", () => ({ deliverActivity }));
vi.mock("@/lib/db", () => ({
  prisma: {
    failedDelivery: { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { retryFailedDeliveries } from "@/lib/delivery-retry";
import { prisma } from "@/lib/db";

const NOW = new Date("2026-07-06T12:00:00.000Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: "d1", inbox: "https://m.example/inbox", activityId: "https://me/ap/create/1",
  activity: JSON.stringify({ id: "https://me/ap/create/1", type: "Create" }),
  attempts: 1, nextRetryAt: new Date("2026-07-06T11:58:00.000Z"), failedAt: null,
  createdAt: new Date("2026-07-06T11:55:00.000Z"), ...over,
});

// findMany is called twice per run: due rows, then (nothing — prune uses deleteMany).
function mockDue(rows: unknown[]) {
  vi.mocked(prisma.failedDelivery.findMany).mockResolvedValue(rows as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDue([]);
  vi.mocked(prisma.failedDelivery.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.failedDelivery.deleteMany).mockResolvedValue({ count: 0 } as never);
  deliverActivity.mockResolvedValue({ ok: true, status: 202 });
});

describe("retryFailedDeliveries (#207)", () => {
  it("queries only due, non-terminal rows", async () => {
    await retryFailedDeliveries(NOW);
    const where = vi.mocked(prisma.failedDelivery.findMany).mock.calls[0][0]?.where as Record<string, unknown>;
    expect(where.failedAt).toBeNull();
    expect(where.nextRetryAt).toEqual({ lte: NOW });
  });

  it("deletes a row on successful redelivery", async () => {
    mockDue([row()]);
    const r = await retryFailedDeliveries(NOW);
    expect(deliverActivity).toHaveBeenCalledWith("https://m.example/inbox", { id: "https://me/ap/create/1", type: "Create" });
    expect(prisma.failedDelivery.deleteMany).toHaveBeenCalledWith({ where: { id: "d1" } });
    expect(r.delivered).toBe(1);
  });

  it("claims each row atomically (compare-and-swap on nextRetryAt); a lost race skips it", async () => {
    mockDue([row()]);
    vi.mocked(prisma.failedDelivery.updateMany).mockResolvedValue({ count: 0 } as never); // claim lost
    const r = await retryFailedDeliveries(NOW);
    expect(deliverActivity).not.toHaveBeenCalled();
    expect(r.claimed).toBe(0);
    const claim = vi.mocked(prisma.failedDelivery.updateMany).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(claim.where).toEqual({ id: "d1", nextRetryAt: row().nextRetryAt });
  });

  it("on failure, increments attempts and reschedules with the next backoff step", async () => {
    mockDue([row({ attempts: 1 })]);
    deliverActivity.mockResolvedValue({ ok: false, status: 500, error: "boom" });
    await retryFailedDeliveries(NOW);
    // First call is the claim; a later call reschedules with attempts=2 + a future nextRetryAt.
    const reschedule = vi.mocked(prisma.failedDelivery.updateMany).mock.calls
      .map((c) => c[0].data as Record<string, unknown>)
      .find((d) => d.attempts === 2);
    expect(reschedule).toBeTruthy();
    expect(reschedule!.failedAt).toBeUndefined();
    // attempts=2 → BACKOFF[1] = 10 min after now
    expect((reschedule!.nextRetryAt as Date).getTime()).toBe(NOW.getTime() + 10 * 60_000);
  });

  it("still RESCHEDULES at attempts=4→5 (24h step), NOT give up — brackets the give-up boundary from below", async () => {
    mockDue([row({ attempts: 4 })]);
    deliverActivity.mockResolvedValue({ ok: false, status: 500, error: "down" });
    const r = await retryFailedDeliveries(NOW);
    const data = vi.mocked(prisma.failedDelivery.updateMany).mock.calls
      .map((c) => c[0].data as Record<string, unknown>)
      .find((d) => d.attempts === 5);
    expect(data).toBeTruthy();
    expect(data!.failedAt).toBeUndefined(); // rescheduled, not terminal
    expect((data!.nextRetryAt as Date).getTime()).toBe(NOW.getTime() + 1440 * 60_000); // BACKOFF[4] = 24h
    expect(r.gaveUp).toBe(0);
  });

  it("gives up (sets failedAt) once attempts reach the max", async () => {
    mockDue([row({ attempts: 5 })]); // next failure → 6 == MAX
    deliverActivity.mockResolvedValue({ ok: false, status: 500, error: "still down" });
    const r = await retryFailedDeliveries(NOW);
    const terminal = vi.mocked(prisma.failedDelivery.updateMany).mock.calls
      .map((c) => c[0].data as Record<string, unknown>)
      .find((d) => d.failedAt);
    expect(terminal).toBeTruthy();
    expect(terminal!.attempts).toBe(6);
    expect(r.gaveUp).toBe(1);
  });

  it("gives up on an unparseable stored activity (no delivery attempt)", async () => {
    mockDue([row({ activity: "{not json" })]);
    const r = await retryFailedDeliveries(NOW);
    expect(deliverActivity).not.toHaveBeenCalled();
    expect(r.gaveUp).toBe(1);
  });

  it("prunes ONLY terminal rows by failedAt age — never a still-pending row (no data loss on a resumed queue)", async () => {
    await retryFailedDeliveries(NOW);
    const where = vi.mocked(prisma.failedDelivery.deleteMany).mock.calls.at(-1)![0]?.where as {
      failedAt: { lt: Date };
    };
    // `failedAt: { lt }` matches only rows with a non-null failedAt, so a pending
    // (failedAt=null) row is untouched regardless of how old it is.
    expect(where.failedAt.lt).toBeInstanceOf(Date);
    expect(where.failedAt.lt.getTime()).toBe(NOW.getTime() - 3 * 24 * 60 * 60_000);
    expect(where).not.toHaveProperty("OR");
    expect(where).not.toHaveProperty("createdAt");
  });
});
