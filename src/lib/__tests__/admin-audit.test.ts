import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin } = vi.hoisted(() => ({ verifyAdmin: vi.fn() }));
vi.mock("@/lib/auth", () => ({ verifyAdmin }));
vi.mock("@/lib/db", () => ({ prisma: { appTokenUsage: { findMany: vi.fn() } } }));

import { GET } from "@/app/api/admin/audit/route";
import { prisma } from "@/lib/db";

function req(params: Record<string, string> = {}): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.appTokenUsage.findMany).mockResolvedValue([] as never);
});

describe("GET /api/admin/audit", () => {
  it("401 when not an admin", async () => {
    verifyAdmin.mockResolvedValue(false);
    expect((await GET(req())).status).toBe(401);
    expect(prisma.appTokenUsage.findMany).not.toHaveBeenCalled();
  });

  it("returns recent events (normalized) for the owner", async () => {
    verifyAdmin.mockResolvedValue(true);
    vi.mocked(prisma.appTokenUsage.findMany).mockResolvedValue([
      { id: "u1", label: "mac", clientId: "fedihome-macos", scope: "read create", method: "POST", path: "/api/micropub", at: new Date("2026-01-01T00:00:00Z") },
    ] as never);
    const body = await (await GET(req())).json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ label: "mac", method: "POST", path: "/api/micropub", at: "2026-01-01T00:00:00.000Z" });
  });

  it("caps the limit at 200", async () => {
    verifyAdmin.mockResolvedValue(true);
    await GET(req({ limit: "9999" }));
    expect(vi.mocked(prisma.appTokenUsage.findMany).mock.calls[0][0]?.take).toBe(200);
  });
});
