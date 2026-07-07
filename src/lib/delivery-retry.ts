import { prisma } from "./db";
import { deliverActivity } from "./http-signatures";

/**
 * Retry persisted failed follower deliveries (#207). Runs on the scheduler's
 * tick. Each due row is claimed atomically (its nextRetryAt is pushed forward
 * with an update-where-unchanged guard) so overlapping ticks / instances can't
 * both retry it; on success the row is deleted, on failure it's rescheduled
 * with backoff, and after MAX_ATTEMPTS it's marked terminal (failedAt).
 * Re-sending the stored activity JSON keeps the id stable, so remote servers
 * dedupe a delivery that actually did land.
 */

// Backoff before each retry, indexed by the attempt count so far: after the
// hot-path failure (attempts=1) the first retry waits 2m, then 10m, 1h, 6h, 24h.
const BACKOFF_MS = [2, 10, 60, 360, 1440].map((m) => m * 60_000);
const MAX_ATTEMPTS = 6; // 1 hot-path + 5 retries across ~31h, then give up
const CLAIM_LEASE_MS = 5 * 60_000; // hold a claimed row out of the next tick's view
// Drop TERMINAL (gave-up) rows this long after they failed, keeping a short
// window for observability. Deliberately keyed on failedAt, never createdAt —
// a still-pending row (failedAt null) must never be pruned by age, or a queue
// that sat while the job was disabled/down would be wiped instead of draining.
const PRUNE_TERMINAL_AFTER_MS = 3 * 24 * 60 * 60_000;
const BATCH = 25;

export interface RetrySummary {
  claimed: number;
  delivered: number;
  gaveUp: number;
  pruned: number;
}

export async function retryFailedDeliveries(now: Date = new Date()): Promise<RetrySummary> {
  const due = await prisma.failedDelivery.findMany({
    where: { failedAt: null, nextRetryAt: { lte: now } },
    orderBy: { nextRetryAt: "asc" },
    take: BATCH,
  });

  let claimed = 0;
  let delivered = 0;
  let gaveUp = 0;

  for (const row of due) {
    // Claim: push nextRetryAt out; only the run that matches the current value wins.
    const claim = await prisma.failedDelivery.updateMany({
      where: { id: row.id, nextRetryAt: row.nextRetryAt },
      data: { nextRetryAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (claim.count !== 1) continue; // another run took it
    claimed++;

    let activity: Record<string, unknown>;
    try {
      activity = JSON.parse(row.activity);
    } catch {
      await prisma.failedDelivery.updateMany({
        where: { id: row.id },
        data: { failedAt: now, lastError: "unparseable stored activity" },
      });
      gaveUp++;
      continue;
    }

    const res = await deliverActivity(row.inbox, activity);
    if (res.ok) {
      await prisma.failedDelivery.deleteMany({ where: { id: row.id } });
      delivered++;
      continue;
    }

    const attempts = row.attempts + 1;
    const lastError = (res.error || `status ${res.status}`).slice(0, 300);
    if (attempts >= MAX_ATTEMPTS) {
      await prisma.failedDelivery.updateMany({ where: { id: row.id }, data: { attempts, failedAt: now, lastError } });
      gaveUp++;
    } else {
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
      await prisma.failedDelivery.updateMany({
        where: { id: row.id },
        data: { attempts, nextRetryAt: new Date(now.getTime() + delay), lastError },
      });
    }
  }

  // Prune terminal rows a few days after they gave up. `failedAt: { lt }`
  // matches ONLY rows with a set (non-null) failedAt, so a still-pending row is
  // never touched — the table can't grow unbounded while the job runs (every
  // row resolves to delivered→deleted or terminal→pruned within ~31h + grace).
  const pruned = await prisma.failedDelivery
    .deleteMany({ where: { failedAt: { lt: new Date(now.getTime() - PRUNE_TERMINAL_AFTER_MS) } } })
    .then((r) => r.count)
    .catch(() => 0);

  return { claimed, delivered, gaveUp, pruned };
}
