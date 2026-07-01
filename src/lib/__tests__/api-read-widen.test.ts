import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { authenticateApiRequest, verifyOrigin } = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  verifyOrigin: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateApiRequest,
  verifyOrigin,
  hasScope: (s: string | undefined, r: string) => (s ?? "").split(/\s+/).includes(r),
}));
vi.mock("@/lib/notifications", () => ({ computeNotifications: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediPost: { findMany: vi.fn() },
    siteSetting: { upsert: vi.fn() },
  },
}));

import { GET as feedGET } from "@/app/api/feed/route";
import { GET as notifGET, POST as notifPOST } from "@/app/api/notifications/route";
import { POST as countsPOST } from "@/app/api/fedi-post-counts/route";
import { prisma } from "@/lib/db";
import { computeNotifications } from "@/lib/notifications";

const ok = (via: "bearer" | "cookie", scope = "read") => ({ ok: true, via, scope });
const no = { ok: false, via: null, scope: "" };
const badScope = { ok: false, via: "bearer", scope: "read" };

function feedReq(): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams("") } } as unknown as NextRequest;
}
function bareReq(): NextRequest {
  return {} as unknown as NextRequest;
}
function jsonReq(body: unknown): NextRequest {
  return new Request("https://x/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const NOTIFS = {
  count: 2,
  items: [
    { id: "n1", type: "like", createdAt: "2026-01-02" },
    { id: "n2", type: "dm", createdAt: "2026-01-01" },
  ],
  categoryCounts: { like: 1, dm: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.siteSetting.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.fediPost.findMany).mockResolvedValue([] as never);
  vi.mocked(computeNotifications).mockResolvedValue(JSON.parse(JSON.stringify(NOTIFS)));
});

describe("read endpoints accept a `read` bearer (Phase B)", () => {
  it("GET /api/feed — 401 with no auth", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await feedGET(feedReq())).status).toBe(401);
    expect(authenticateApiRequest).toHaveBeenCalledWith(expect.anything(), "read");
  });

  it("GET /api/feed — 200 for a read bearer", async () => {
    authenticateApiRequest.mockResolvedValue(ok("bearer"));
    vi.mocked(prisma.fediPost.findMany).mockResolvedValue(
      [{ id: "p1", contentHtml: "<p>hi</p>", publishedAt: new Date() }] as never,
    );
    const res = await feedGET(feedReq());
    expect(res.status).toBe(200);
    expect((await res.json()).posts).toHaveLength(1);
  });
});

describe("GET /api/notifications — DM items require `dm` scope", () => {
  it("redacts dm items + their unread count for a read-only token", async () => {
    authenticateApiRequest.mockResolvedValue(ok("bearer", "read"));
    const body = await (await notifGET(bareReq())).json();
    expect(body.items.map((i: { type: string }) => i.type)).toEqual(["like"]);
    expect(body.categoryCounts.dm).toBeUndefined();
    expect(body.count).toBe(1); // 2 total − 1 unread dm
  });

  it("shows dm items to a `dm`-scoped token", async () => {
    authenticateApiRequest.mockResolvedValue(ok("bearer", "read dm"));
    const body = await (await notifGET(bareReq())).json();
    expect(body.items).toHaveLength(2);
    expect(body.count).toBe(2);
  });

  it("shows dm items to the owner cookie", async () => {
    authenticateApiRequest.mockResolvedValue(ok("cookie", "*"));
    const body = await (await notifGET(bareReq())).json();
    expect(body.items).toHaveLength(2);
  });

  it("returns the empty shape with no auth", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    const body = await (await notifGET(bareReq())).json();
    expect(body).toEqual({ count: 0, items: [], categoryCounts: {} });
  });
});

describe("mark-read POST needs `interact`; cookie keeps CSRF, bearer skips it", () => {
  it("requires the interact scope", async () => {
    authenticateApiRequest.mockResolvedValue(ok("bearer", "interact"));
    await notifPOST(jsonReq({}));
    expect(authenticateApiRequest).toHaveBeenCalledWith(expect.anything(), "interact");
  });

  it("403 insufficient_scope for a bearer lacking interact", async () => {
    authenticateApiRequest.mockResolvedValue(badScope);
    const res = await notifPOST(jsonReq({}));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("insufficient_scope");
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalled();
  });

  it("bearer path succeeds without an origin check", async () => {
    authenticateApiRequest.mockResolvedValue(ok("bearer", "interact"));
    const res = await notifPOST(jsonReq({}));
    expect(res.status).toBe(200);
    expect(verifyOrigin).not.toHaveBeenCalled();
    expect(prisma.siteSetting.upsert).toHaveBeenCalled();
  });

  it("cookie path is rejected without a valid origin (CSRF)", async () => {
    authenticateApiRequest.mockResolvedValue(ok("cookie", "*"));
    verifyOrigin.mockReturnValue(false);
    const res = await notifPOST(jsonReq({}));
    expect(res.status).toBe(403);
    expect(prisma.siteSetting.upsert).not.toHaveBeenCalled();
  });

  it("cookie path succeeds with a valid origin", async () => {
    authenticateApiRequest.mockResolvedValue(ok("cookie", "*"));
    verifyOrigin.mockReturnValue(true);
    expect((await notifPOST(jsonReq({}))).status).toBe(200);
  });

  it("401 with no auth", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await notifPOST(jsonReq({}))).status).toBe(401);
  });
});

describe("fedi-post-counts POST — cookie/bearer CSRF split", () => {
  it("bearer path passes auth (then 400 for the missing postId)", async () => {
    authenticateApiRequest.mockResolvedValue(ok("bearer"));
    const res = await countsPOST(jsonReq({}));
    expect(res.status).toBe(400); // got past auth+csrf, failed on postId
    expect(verifyOrigin).not.toHaveBeenCalled();
  });

  it("cookie path without origin is 403", async () => {
    authenticateApiRequest.mockResolvedValue(ok("cookie", "*"));
    verifyOrigin.mockReturnValue(false);
    expect((await countsPOST(jsonReq({}))).status).toBe(403);
  });
});
