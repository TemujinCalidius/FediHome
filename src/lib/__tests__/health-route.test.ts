import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn(), authToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } },
}));

import { GET } from "@/app/api/health/route";
import { prisma } from "@/lib/db";

describe("GET /api/health", () => {
  beforeEach(() => vi.clearAllMocks());

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
