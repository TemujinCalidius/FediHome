import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { authenticateApiRequest, verifyOrigin, tag } = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  verifyOrigin: vi.fn(),
  // Stub every action handler so the preamble is exercised in isolation.
  tag: (name: string) => vi.fn(() => new Response(JSON.stringify({ handler: name }), { status: 200 })),
}));
vi.mock("@/lib/auth", () => ({
  authenticateApiRequest,
  verifyOrigin,
  hasScope: (s: string | undefined, r: string) => (s ?? "").split(/\s+/).includes(r),
}));

vi.mock("@/app/api/admin/_actions/comments", () => ({ approveComment: tag("approveComment"), rejectComment: tag("rejectComment") }));
vi.mock("@/app/api/admin/_actions/replies", () => ({ reply: tag("reply"), editReply: tag("editReply"), backfillReplies: tag("backfillReplies") }));
vi.mock("@/app/api/admin/_actions/dms", () => ({ fediDm: tag("fediDm"), bskyDm: tag("bskyDm"), markDmRead: tag("markDmRead"), markAllDmsRead: tag("markAllDmsRead") }));
vi.mock("@/app/api/admin/_actions/fedi-graph", () => ({ follow: tag("follow"), unfollow: tag("unfollow"), unfollowByUri: tag("unfollowByUri"), block: tag("block") }));
vi.mock("@/app/api/admin/_actions/fedi-interactions", () => ({ like: tag("like"), boost: tag("boost"), unlike: tag("unlike"), unboost: tag("unboost") }));
vi.mock("@/app/api/admin/_actions/bluesky", () => ({ bskyReply: tag("bskyReply"), syncGraph: tag("syncGraph"), bskyFollow: tag("bskyFollow"), bskyUnfollow: tag("bskyUnfollow") }));

import { POST } from "@/app/api/admin/route";

const bearer = (scope: string) => ({ ok: true, via: "bearer", scope });
const cookie = { ok: true, via: "cookie", scope: "*" };
const no = { ok: false, via: null, scope: "" };

function req(body: unknown): NextRequest {
  return new Request("https://x/api/admin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyOrigin.mockReturnValue(true);
});

describe("/api/admin — per-action scope map", () => {
  it.each([
    ["like", "interact"],
    ["boost", "interact"],
    ["reply", "interact"],
    ["follow", "interact"],
    ["bsky_follow", "interact"],
    ["dm_reply", "dm"],
    ["dm_new_fedi", "dm"],
    ["mark_all_dms_read", "dm"],
    ["approve_comment", "manage"],
    ["backfill_replies", "manage"],
    ["sync_bluesky_graph", "manage"],
    ["block", "manage"], // reclassified: block deletes the actor's posts/interactions
  ])("action %s dispatches with %s and 403s without it", async (action, scope) => {
    authenticateApiRequest.mockResolvedValue(bearer(scope));
    expect((await POST(req({ action }))).status).toBe(200);

    authenticateApiRequest.mockResolvedValue(bearer("read")); // a token lacking the write scope
    const denied = await POST(req({ action }));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("insufficient_scope");
  });

  it("block requires `manage`, NOT `interact` (it's destructive)", async () => {
    authenticateApiRequest.mockResolvedValue(bearer("interact"));
    expect((await POST(req({ action: "block" }))).status).toBe(403);
    authenticateApiRequest.mockResolvedValue(bearer("manage"));
    expect((await POST(req({ action: "block" }))).status).toBe(200);
  });

  it("the owner cookie satisfies any action (no scope gate)", async () => {
    authenticateApiRequest.mockResolvedValue(cookie);
    expect((await POST(req({ action: "block" }))).status).toBe(200);
  });
});

describe("/api/admin — auth + CSRF gates", () => {
  it("401 with no auth (before parsing the body)", async () => {
    authenticateApiRequest.mockResolvedValue(no);
    expect((await POST(req({ action: "like" }))).status).toBe(401);
  });

  it("cookie path is rejected without a valid origin (CSRF)", async () => {
    authenticateApiRequest.mockResolvedValue(cookie);
    verifyOrigin.mockReturnValue(false);
    expect((await POST(req({ action: "like" }))).status).toBe(403);
  });

  it("bearer path dispatches without an origin check", async () => {
    authenticateApiRequest.mockResolvedValue(bearer("interact"));
    const res = await POST(req({ action: "like" }));
    expect(res.status).toBe(200);
    expect((await res.json()).handler).toBe("like");
    expect(verifyOrigin).not.toHaveBeenCalled();
  });

  it("400 for an unknown action (after auth passes)", async () => {
    authenticateApiRequest.mockResolvedValue(cookie);
    expect((await POST(req({ action: "nuke_everything" }))).status).toBe(400);
  });
});
