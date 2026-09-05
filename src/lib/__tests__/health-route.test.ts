import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn(), authToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } },
}));

const { schedulerLastTickAgoMs, schedulerStarted } = vi.hoisted(() => ({
  schedulerLastTickAgoMs: vi.fn(),
  schedulerStarted: vi.fn(),
}));
/**
 * MOCKED AT THE FILESYSTEM, NOT AT `volumeSpace` (#586).
 *
 * The route now asks `worstStorageStatus()`, which classifies EVERY uploads
 * root, and it calls `volumeSpace` intra-module — so a mocked export is never
 * consulted. Stubbing it would have left these tests asserting nothing while
 * still passing, which is the trap #574 was about.
 *
 * `statfs` and `uploadsRoots` instead: the real `worstStorageStatus` and the
 * real `classifySpace` both run, so the thresholds these assertions are about
 * are still the live ones — and the multi-root behaviour is now testable.
 */
const { statfs, uploadsRoots } = vi.hoisted(() => ({
  statfs: vi.fn(),
  uploadsRoots: vi.fn(),
}));
vi.mock("node:fs/promises", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  statfs,
}));
vi.mock("@/lib/uploads-dir", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  uploadsRoots,
  uploadsDir: async () => "/srv/up",
}));

/** A volume with this much free, out of this much total. */
const volume = (availableBytes: number, totalBytes: number) => ({
  bsize: 1,
  bavail: availableBytes,
  blocks: totalBytes,
});
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
    uploadsRoots.mockResolvedValue(["/srv/up"]);
    statfs.mockResolvedValue(volume(50 * 1024 ** 3, 100 * 1024 ** 3));
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

describe("storage (#385)", () => {
  it("reports a status, never a byte count — this endpoint is public", async () => {
    const body = await (await GET()).json();
    expect(body.storage).toBe("ok");
    // How big the disk is and how full it is are nobody else's business, for the
    // same reason `db` reports "ok" rather than a connection string.
    expect(JSON.stringify(body)).not.toMatch(/availableBytes|volumeBytes|uploadsDir/);
  });

  it("reports a full disk WITHOUT marking the instance unhealthy", async () => {
    // The Docker healthcheck restarts a degraded container, and restarting does
    // not free space — it would crash-loop. Report it; let a monitor decide.
    statfs.mockResolvedValue(volume(10 * 1024 ** 2, 100 * 1024 ** 3));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.storage).toBe("critical");
    expect(body.status).toBe("ok");
  });

  it("reports the WORST root, not just the configured one (#586)", async () => {
    // The failure this fixes: after a move, the old root still holds everything
    // written before it and is frequently a separate volume with a fixed size.
    // It can fill to 100% while a single-statfs check says "ok" throughout,
    // because it is measuring a different filesystem entirely.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ ok: 1 }] as never);
    uploadsRoots.mockResolvedValue(["/srv/new", "/srv/old"]);
    statfs.mockImplementation(async (dir: string) =>
      dir === "/srv/old"
        ? volume(10 * 1024 ** 2, 100 * 1024 ** 3) // the old volume is full
        : volume(50 * 1024 ** 3, 100 * 1024 ** 3), // the new one is roomy
    );
    const body = await (await GET()).json();
    expect(body.storage).toBe("critical");
    // Still not unhealthy — restarting a container does not free disk.
    expect(body.status).toBe("ok");
  });

  it("still says ok when every root is roomy", async () => {
    // The control. A check that reported "critical" for two healthy volumes
    // would be worse than the single-root one it replaces.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ ok: 1 }] as never);
    uploadsRoots.mockResolvedValue(["/srv/new", "/srv/old"]);
    statfs.mockResolvedValue(volume(50 * 1024 ** 3, 100 * 1024 ** 3));
    expect((await (await GET()).json()).storage).toBe("ok");
  });

  it("never puts an uploads path in the response", async () => {
    // This endpoint is public and unauthenticated, and the route's own docstring
    // says how big your disk is and how full it is are nobody else's business.
    // #586 asked which root the status describes; the answer is a STATUS, and
    // the path stays in the support bundle and the admin panel, which are gated.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ ok: 1 }] as never);
    uploadsRoots.mockResolvedValue(["/srv/new", "/mnt/secret-volume/uploads"]);
    statfs.mockResolvedValue(volume(10 * 1024 ** 2, 100 * 1024 ** 3));
    const text = JSON.stringify(await (await GET()).json());
    expect(text).not.toContain("/srv/new");
    expect(text).not.toContain("/mnt/secret-volume");
    expect(text).not.toMatch(/availableBytes|totalBytes|bavail/);
  });

  it("says unknown rather than guessing when free space can't be read", async () => {
    statfs.mockRejectedValue(new Error("statfs failed"));
    const body = await (await GET()).json();
    expect(body.storage).toBe("unknown");
    expect(body.status).toBe("ok");
  });
});

