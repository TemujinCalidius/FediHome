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
  // Who the delivery was for (#397). NULL on a shared-inbox row.
  actorUri: "https://m.example/users/ada",
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
    expect(deliverActivity).toHaveBeenCalledWith(
      "https://m.example/inbox",
      { id: "https://me/ap/create/1", type: "Create" },
      { actorUri: "https://m.example/users/ada" },
    );
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

describe("permanent failures don't ride the 31-hour ladder (#379)", () => {
  const row = { id: "r1", inbox: "https://spam.example/inbox", activityId: "a1", activity: "{}", attempts: 1, nextRetryAt: new Date(0) };

  beforeEach(() => {
    vi.mocked(prisma.failedDelivery.findMany).mockResolvedValue([row] as never);
    vi.mocked(prisma.failedDelivery.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.failedDelivery.deleteMany).mockResolvedValue({ count: 1 } as never);
  });

  it("DELETES a row we now refuse to deliver, rather than marking it failed", async () => {
    // A failedAt row would sit in the observability window implying the remote
    // server misbehaved, when in fact this was our own block.
    vi.mocked(deliverActivity).mockResolvedValue({ ok: false, status: 0, error: "blocked: domain", permanent: true, blockedBy: "domain" } as never);
    const r = await retryFailedDeliveries(new Date());
    expect(r.discarded).toBe(1);
    expect(r.gaveUp).toBe(0);
    expect(prisma.failedDelivery.deleteMany).toHaveBeenCalledWith({ where: { id: "r1" } });
  });

  it("gives up immediately on a definitive remote refusal", async () => {
    vi.mocked(deliverActivity).mockResolvedValue({ ok: false, status: 410, error: "410: gone", permanent: true } as never);
    const r = await retryFailedDeliveries(new Date());
    expect(r.gaveUp).toBe(1);
    const call = vi.mocked(prisma.failedDelivery.updateMany).mock.calls.at(-1)?.[0] as { data: { failedAt?: Date } };
    expect(call.data.failedAt).toBeInstanceOf(Date);
  });

  it("still backs off a 500 exactly as before", async () => {
    // The whole retry queue exists for transient failures; this must not regress.
    vi.mocked(deliverActivity).mockResolvedValue({ ok: false, status: 500, error: "500: oops" } as never);
    const r = await retryFailedDeliveries(new Date());
    expect(r.gaveUp).toBe(0);
    expect(r.discarded).toBe(0);
    const call = vi.mocked(prisma.failedDelivery.updateMany).mock.calls.at(-1)?.[0] as { data: { nextRetryAt?: Date } };
    expect(call.data.nextRetryAt).toBeInstanceOf(Date);
  });
});

describe("the sweep can enforce an ACCOUNT block, not just a host one (#397)", () => {
  beforeEach(() => {
    vi.mocked(prisma.failedDelivery.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.failedDelivery.deleteMany).mockResolvedValue({ count: 1 } as never);
  });

  it("passes the recipient, so blockedRecipient can check the actor at all", async () => {
    // Without this the sweep called deliverActivity with two arguments,
    // blockedRecipient saw actorUri: undefined, and only the DOMAIN half of the
    // check could ever fire — an account block was unenforceable on replay.
    mockDue([row({ actorUri: "https://m.example/users/mallory" })]);
    vi.mocked(deliverActivity).mockResolvedValue({ ok: true, status: 202 } as never);

    await retryFailedDeliveries(NOW);

    expect(vi.mocked(deliverActivity).mock.calls[0][2]).toEqual({
      actorUri: "https://m.example/users/mallory",
    });
  });

  it("discards a row refused because the account is blocked", async () => {
    mockDue([row({ actorUri: "https://m.example/users/mallory" })]);
    vi.mocked(deliverActivity).mockResolvedValue({
      ok: false, status: 0, error: "blocked: actor", permanent: true, blockedBy: "actor",
    } as never);

    const r = await retryFailedDeliveries(NOW);

    expect(r.discarded).toBe(1);
    expect(prisma.failedDelivery.deleteMany).toHaveBeenCalledWith({ where: { id: "d1" } });
  });

  it("passes null for a shared inbox rather than pinning one recipient to it", async () => {
    // One delivery to a shared inbox serves everyone behind it, so suppressing
    // it because a single recipient is blocked would withhold the post from all
    // the others. purgeQueuedDeliveriesForInbox declines to purge a shared inbox
    // for the same reason — the two agree by construction.
    mockDue([row({ actorUri: null })]);
    vi.mocked(deliverActivity).mockResolvedValue({ ok: true, status: 202 } as never);

    await retryFailedDeliveries(NOW);

    expect(vi.mocked(deliverActivity).mock.calls[0][2]).toEqual({ actorUri: null });
  });
});

