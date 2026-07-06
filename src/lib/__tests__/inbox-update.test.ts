import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyIncomingSignature, actorMatchesSigner, deliverActivity, processAttachments, fetchLinkEmbed, sendPushToOwner } =
  vi.hoisted(() => ({
    verifyIncomingSignature: vi.fn(),
    actorMatchesSigner: vi.fn(),
    deliverActivity: vi.fn(),
    processAttachments: vi.fn(),
    fetchLinkEmbed: vi.fn(),
    sendPushToOwner: vi.fn(),
  }));
vi.mock("@/lib/http-signatures", () => ({ verifyIncomingSignature, actorMatchesSigner, deliverActivity }));
vi.mock("@/lib/fedi-media", () => ({ processAttachments, fetchLinkEmbed }));
vi.mock("@/lib/push", () => ({ sendPushToOwner }));
vi.mock("@/lib/notifications", () => ({ resolveOwnedTarget: vi.fn() }));
vi.mock("@/lib/url-guard", () => ({ assertPublicHost: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    fediPost: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    fediInteraction: { updateMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    fediFollowing: { findUnique: vi.fn() },
    fediFollower: { findUnique: vi.fn(), findMany: vi.fn() },
    post: { findFirst: vi.fn() },
    photo: { findFirst: vi.fn() },
    directMessage: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { POST } from "@/app/ap/inbox/route";
import { prisma } from "@/lib/db";

const ACTOR = "https://mastodon.example/users/ada";
const OTHER = "https://mastodon.example/users/mallory";
const NOTE_ID = "https://mastodon.example/users/ada/statuses/1";

function inboxReq(activity: Record<string, unknown>): NextRequest {
  return new Request("https://demo.example/ap/inbox", {
    method: "POST",
    headers: { "content-type": "application/activity+json" },
    body: JSON.stringify(activity),
  }) as unknown as NextRequest;
}

const update = (over: Record<string, unknown> = {}, noteOver: Record<string, unknown> = {}) => ({
  type: "Update",
  actor: ACTOR,
  object: {
    type: "Note",
    id: NOTE_ID,
    content: "<p>edited body</p>",
    updated: "2026-07-05T10:00:00Z",
    ...noteOver,
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Signature layer passes; the ownership gate under test is the handler's own.
  verifyIncomingSignature.mockImplementation(async (_req: unknown, raw: string) => ({
    valid: true,
    actorUri: (JSON.parse(raw) as { actor: string }).actor,
  }));
  actorMatchesSigner.mockReturnValue(true);
  processAttachments.mockResolvedValue({ urls: [], types: [] });
  fetchLinkEmbed.mockResolvedValue(null);
  vi.mocked(prisma.fediPost.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.fediPost.update).mockResolvedValue({} as never);
  vi.mocked(prisma.fediInteraction.updateMany).mockResolvedValue({ count: 0 } as never);
});

describe("inbox Update(Note|Article) — #205", () => {
  it("applies a remote edit to the stored FediPost with re-sanitized content + editedAt", async () => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({ apId: NOTE_ID, actorUri: ACTOR } as never);
    const res = await POST(inboxReq(update({}, { content: '<p>edited</p><script>alert(1)</script>' })));
    expect(res.status).toBe(202);
    expect(prisma.fediPost.update).toHaveBeenCalledTimes(1);
    const data = vi.mocked(prisma.fediPost.update).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.content).not.toContain("<script>");
    expect(data.content).toContain("edited");
    expect(data.contentHtml).toBe(data.content);
    expect(data.editedAt).toEqual(new Date("2026-07-05T10:00:00Z"));
  });

  it("preserves an Article's title as an escaped heading, like Create ingest", async () => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({ apId: NOTE_ID, actorUri: ACTOR } as never);
    await POST(inboxReq(update({}, { type: "Article", name: "New <b>title</b>", content: "<p>body</p>" })));
    const data = vi.mocked(prisma.fediPost.update).mock.calls[0][0].data as { content: string };
    expect(data.content).toContain("<h2>");
    expect(data.content).toContain("New &lt;b&gt;title&lt;/b&gt;");
  });

  it("REJECTS an Update whose actor isn't the stored author (same-host spoof)", async () => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({ apId: NOTE_ID, actorUri: ACTOR } as never);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(inboxReq(update({ actor: OTHER })));
    expect(res.status).toBe(202); // accepted transport-wise, but nothing applied
    expect(prisma.fediPost.update).not.toHaveBeenCalled();
    expect(prisma.fediInteraction.updateMany).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("ignores an Update for an object we never stored (no create-from-Update)", async () => {
    await POST(inboxReq(update()));
    expect(prisma.fediPost.update).not.toHaveBeenCalled();
  });

  it("also updates FediInteraction reply rows (the only copy for non-followed repliers), actor-scoped and SANITIZED", async () => {
    await POST(inboxReq(update({}, { content: '<p>edited body</p><script>alert(1)</script><img src=x onerror=alert(2)>' })));
    const call = vi.mocked(prisma.fediInteraction.updateMany).mock.calls[0][0] as {
      where: unknown;
      data: { content: string };
    };
    expect(call.where).toEqual({ sourceApId: NOTE_ID, actorUri: ACTOR, type: "reply" });
    expect(call.data.content).toContain("edited body");
    expect(call.data.content).not.toContain("<script>");
    expect(call.data.content).not.toContain("onerror");
  });

  it("clamps a future-dated `updated` stamp to now (remote-controlled value)", async () => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({ apId: NOTE_ID, actorUri: ACTOR } as never);
    await POST(inboxReq(update({}, { updated: "3000-01-01T00:00:00Z" })));
    const data = vi.mocked(prisma.fediPost.update).mock.calls[0][0].data as { editedAt: Date };
    expect(data.editedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("falls back to 'now' for a missing/invalid updated timestamp", async () => {
    vi.mocked(prisma.fediPost.findUnique).mockResolvedValue({ apId: NOTE_ID, actorUri: ACTOR } as never);
    const before = Date.now();
    await POST(inboxReq(update({}, { updated: "not-a-date" })));
    const data = vi.mocked(prisma.fediPost.update).mock.calls[0][0].data as { editedAt: Date };
    expect(data.editedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("ignores Update objects that aren't Note/Article", async () => {
    await POST(inboxReq({ type: "Update", actor: ACTOR, object: { type: "Person", id: ACTOR } }));
    expect(prisma.fediPost.findUnique).not.toHaveBeenCalled();
    expect(prisma.fediPost.update).not.toHaveBeenCalled();
  });
});
