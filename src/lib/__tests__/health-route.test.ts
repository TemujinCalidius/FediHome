import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn(), authToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } },
}));

const { schedulerLastTickAgoMs, schedulerStarted } = vi.hoisted(() => ({
  schedulerLastTickAgoMs: vi.fn(),
  schedulerStarted: vi.fn(),
}));
vi.mock("@/lib/scheduler", () => ({
  schedulerLastTickAgoMs,
  schedulerStarted,
  SCHEDULER_TICK_MS: 15_000,
}));

import { GET } from "@/app/api/health/route";
import { prisma } from "@/lib/db";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: scheduler running and freshly ticked.
    schedulerStarted.mockReturnValue(true);
    schedulerLastTickAgoMs.mockReturnValue(1_000);
  });

  it("returns 200 + db:ok + a version when the DB round-trips", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ ok: 1 }] as never);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", db: "ok" });
    expect(typeof body.version).toBe("string");
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it("returns 503 + db:error when the DB is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("connection refused") as never);
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ status: "degraded", db: "error" });
  });
});

/**
 * The scheduler runs IN-PROCESS (src/instrumentation.ts). It can wedge while
 * HTTP keeps answering 200 — an instance that looks perfectly healthy while
 * silently no longer publishing scheduled posts. A health check that can't see
 * that is worse than misleading: it actively reassures. (#358)
 */
describe("GET /api/health — build identity and scheduler liveness (#358)", () => {
  beforeEach(() => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ ok: 1 }] as never);
  });

  it("reports uptime, a build field and scheduler state", async () => {
    const body = await (await GET()).json();
    expect(typeof body.uptimeSeconds).toBe("number");
    expect("build" in body).toBe(true); // null is valid — not every install can know
    expect(body.scheduler).toMatchObject({ running: true });
    expect(typeof body.scheduler.lastTickSecondsAgo).toBe("number");
  });

  it("goes degraded when the scheduler has stopped ticking", async () => {
    schedulerLastTickAgoMs.mockReturnValue(15_000 * 21); // past the staleness bound
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.db).toBe("ok"); // the DB is fine — it's the scheduler that's wedged
    expect(body.scheduler.running).toBe(false);
  });

  it("tolerates a slow single pass without flapping", async () => {
    // A big Bluesky sync can take a while; only a genuinely stopped loop counts.
    schedulerLastTickAgoMs.mockReturnValue(15_000 * 5);
    expect((await GET()).status).toBe(200);
  });

  it("stays healthy when the scheduler was never started in this process", async () => {
    // Next can run more than one worker; a process without the scheduler is not
    // itself unhealthy.
    schedulerStarted.mockReturnValue(false);
    schedulerLastTickAgoMs.mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).scheduler).toEqual({ running: false, lastTickSecondsAgo: null });
  });
});
