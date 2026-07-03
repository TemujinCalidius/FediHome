import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin, verifyOrigin } = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  verifyOrigin: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ verifyAdmin, verifyOrigin }));
vi.mock("@/lib/db", () => ({
  prisma: { siteSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() } },
}));

import { GET, POST } from "@/app/api/admin/settings/route";
import { prisma } from "@/lib/db";
import { invalidateSchedulerConfigCache } from "@/lib/scheduler-config";

function postReq(body: unknown): NextRequest {
  return new Request("https://x/api/admin/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
const getReq = () => new Request("https://x/api/admin/settings") as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSchedulerConfigCache();
  verifyAdmin.mockResolvedValue(true);
  verifyOrigin.mockReturnValue(true);
  vi.mocked(prisma.siteSetting.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.siteSetting.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.siteSetting.deleteMany).mockResolvedValue({ count: 1 } as never);
});

describe("/api/admin/settings (#59 scheduler slice)", () => {
  it("GET requires admin", async () => {
    verifyAdmin.mockResolvedValue(false);
    expect((await GET(getReq())).status).toBe(401);
  });

  it("GET returns defaults + effective + overrides", async () => {
    vi.mocked(prisma.siteSetting.findMany).mockResolvedValue(
      [{ key: "scheduler.publish.intervalSec", value: "120" }] as never,
    );
    const body = await (await GET(getReq())).json();
    expect(body.defaults.publishScheduled.intervalSec).toBe(60);
    expect(body.effective.publishScheduled.intervalSec).toBe(120);
    expect(body.overrides).toEqual({ "scheduler.publish.intervalSec": "120" });
  });

  it("POST is CSRF-gated (origin) AND admin-gated — cookie surface only", async () => {
    verifyOrigin.mockReturnValue(false);
    expect((await POST(postReq({ settings: { "scheduler.publish.enabled": "false" } }))).status).toBe(403);
    verifyOrigin.mockReturnValue(true);
    verifyAdmin.mockResolvedValue(false);
    expect((await POST(postReq({ settings: { "scheduler.publish.enabled": "false" } }))).status).toBe(401);
  });

  it("rejects unknown keys and invalid values without writing anything", async () => {
    expect((await POST(postReq({ settings: { "scheduler.evil.key": "true" } }))).status).toBe(400);
    expect((await POST(postReq({ settings: { "scheduler.publish.enabled": "maybe" } }))).status).toBe(400);
    expect((await POST(postReq({ settings: { "scheduler.publish.intervalSec": "5" } }))).status).toBe(400); // below 10s floor
    expect((await POST(postReq({ settings: { "scheduler.publish.intervalSec": "999999" } }))).status).toBe(400);
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalled();
  });

  it("upserts valid overrides and deletes null ones (revert to default)", async () => {
    const res = await POST(
      postReq({ settings: { "scheduler.publish.intervalSec": "120", "scheduler.bluesky.enabled": null } }),
    );
    expect(res.status).toBe(200);
    expect(prisma.siteSetting.upsert).toHaveBeenCalledWith({
      where: { key: "scheduler.publish.intervalSec" },
      update: { value: "120" },
      create: { key: "scheduler.publish.intervalSec", value: "120" },
    });
    expect(prisma.siteSetting.deleteMany).toHaveBeenCalledWith({ where: { key: "scheduler.bluesky.enabled" } });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.effective).toBeTruthy();
  });

  it("a save invalidates the scheduler-config cache (changes apply next tick)", async () => {
    // Warm the cache via GET's effective read…
    await GET(getReq());
    const readsBefore = vi.mocked(prisma.siteSetting.findMany).mock.calls.length;
    // …then a POST must invalidate: its own effective re-read hits the DB again.
    await POST(postReq({ settings: { "scheduler.publish.intervalSec": "120" } }));
    expect(vi.mocked(prisma.siteSetting.findMany).mock.calls.length).toBeGreaterThan(readsBefore);
  });
});
