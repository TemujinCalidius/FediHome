import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    post: { findFirst: vi.fn(), findMany: vi.fn() },
    photo: { findFirst: vi.fn(), findMany: vi.fn() },
    fediPost: { findFirst: vi.fn(), findMany: vi.fn() },
    siteSetting: { findUnique: vi.fn() },
    guestComment: { findMany: vi.fn() },
    fediInteraction: { findMany: vi.fn() },
    fediFollower: { findMany: vi.fn() },
    directMessage: { findMany: vi.fn() },
    maintenanceItem: { findMany: vi.fn() },
    blueskyInteraction: { findMany: vi.fn() },
    blueskyReply: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/html-text", () => ({ htmlToText: (s: string) => s }));

import { computeNotifications, resolveOwnedTarget } from "../notifications";
import { prisma } from "@/lib/db";

/** Every list computeNotifications reads, empty. Each test fills in just its own. */
const EMPTY_LISTS = [
  prisma.guestComment.findMany,
  prisma.post.findMany,
  prisma.photo.findMany,
  prisma.fediPost.findMany,
  prisma.fediInteraction.findMany,
  prisma.fediFollower.findMany,
  prisma.directMessage.findMany,
  prisma.maintenanceItem.findMany,
  prisma.blueskyInteraction.findMany,
  prisma.blueskyReply.findMany,
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.post.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.photo.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.fediPost.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.siteSetting.findUnique).mockResolvedValue(null as never);
  for (const fn of EMPTY_LISTS) vi.mocked(fn).mockResolvedValue([] as never);
});

describe("resolveOwnedTarget (#103 ownership gate)", () => {
  it("returns null for an empty apId without querying", async () => {
    expect(await resolveOwnedTarget("")).toBeNull();
    expect(prisma.post.findFirst).not.toHaveBeenCalled();
  });

  it("resolves an owned Post → /post/<slug>", async () => {
    vi.mocked(prisma.post.findFirst).mockResolvedValue({ slug: "hello", title: "Hello" } as never);
    expect(await resolveOwnedTarget("https://x/post/1")).toEqual({ url: "/post/hello", name: "Hello" });
  });

  it("resolves an owned Photo → /photography/<slug> (falls back to slug when untitled)", async () => {
    vi.mocked(prisma.photo.findFirst).mockResolvedValue({ slug: "sunset", title: null } as never);
    expect(await resolveOwnedTarget("https://x/photo/1")).toEqual({ url: "/photography/sunset", name: "sunset" });
  });

  it("resolves our own outgoing reply → /timeline + a content snippet", async () => {
    vi.mocked(prisma.fediPost.findFirst).mockResolvedValue({ content: "a reply" } as never);
    const r = await resolveOwnedTarget("https://x/ap/reply/1");
    expect(r?.url).toBe("/timeline");
    expect(r?.name).toBe("a reply");
    // Only OUR posts count — the FediPost lookup must require isOutgoing.
    expect(prisma.fediPost.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isOutgoing: true }) }),
    );
  });

  it("returns null when the apId isn't ours — the gate that stops phantom badges", async () => {
    expect(await resolveOwnedTarget("https://other.example/post/zzz")).toBeNull();
  });
});

/**
 * The maintenance branch of `computeNotifications()`, which had no coverage at
 * all — not the filters, not the per-kind wording, not the unread count.
 *
 * `MaintenanceItem` is the only durable owner-facing alert channel in the app, and
 * this function is the single source of truth for both the bell and the push badge
 * (#103). So a stale row here doesn't just clutter a list: it lights the
 * home-screen badge and keeps it lit.
 */
describe("computeNotifications — maintenance items (#412)", () => {
  const at = (s: string) => new Date(s);

  const mItem = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    kind: "update",
    packageName: "next",
    current: "16.0.9",
    latest: "16.1.0",
    severity: null,
    title: "next 16.0.9 → 16.1.0",
    description: null,
    url: "https://npmjs.com/next",
    dismissed: false,
    applied: false,
    resolvedAt: null,
    occurrences: 1,
    createdAt: at("2026-07-30T10:00:00Z"),
    ...over,
  });

  const withItems = (rows: Record<string, unknown>[]) =>
    vi.mocked(prisma.maintenanceItem.findMany).mockResolvedValue(rows as never);

  it("asks the database for only the items that are still news", async () => {
    // Three predicates, and `resolvedAt` is the one #412 added: dismissed and
    // applied are the owner's judgement, resolvedAt is the condition itself
    // having gone away.
    await computeNotifications();
    const arg = vi.mocked(prisma.maintenanceItem.findMany).mock.calls[0][0];
    expect(arg?.where).toEqual({ dismissed: false, applied: false, resolvedAt: null });
  });

  it("caps the page, because the bell polls this every 30 seconds", async () => {
    // Unbounded before. An instance that had accumulated one row per upstream
    // release of every watched package loaded all of them, twice a minute.
    const arg = (await computeNotifications(), vi.mocked(prisma.maintenanceItem.findMany).mock.calls[0][0]);
    expect(arg?.take).toBeGreaterThan(0);
  });

  it("surfaces an item and counts it unread", async () => {
    withItems([mItem()]);
    const res = await computeNotifications();
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      id: "maintenance-m1",
      type: "update",
      source: "maintenance",
      actor: "Package update",
      maintenanceId: "m1",
    });
    expect(res.count).toBe(1);
    expect(res.categoryCounts.update).toBe(1);
  });

  it("labels each kind for a human", async () => {
    withItems([
      mItem({ id: "a", kind: "security", severity: "high", title: "" }),
      mItem({ id: "b", kind: "release-note", title: "" }),
      mItem({ id: "c", kind: "federation", packageName: "https://x.example/users/ada", title: "Ada declined your follow request" }),
    ]);
    const res = await computeNotifications();
    const by = Object.fromEntries(res.items.map((i) => [i.id, i]));
    expect(by["maintenance-a"].actor).toBe("Security advisory");
    expect(by["maintenance-a"].summary).toContain("HIGH advisory in next");
    expect(by["maintenance-b"].actor).toBe("New release");
    // A declined follow puts an actor URI in packageName, so the generic
    // "<packageName> released" wording would render the raw URI at the owner.
    expect(by["maintenance-c"].actor).toBe("Fediverse");
    expect(by["maintenance-c"].summary).toBe("Ada declined your follow request");
  });

  it("marks a repeat occurrence as one", async () => {
    // A credential that breaks, is fixed, and breaks again says something a first
    // occurrence doesn't — and resolving rather than deleting is what keeps it.
    withItems([mItem({ occurrences: 3 })]);
    const res = await computeNotifications();
    expect(res.items[0].summary).toBe("next 16.0.9 → 16.1.0 (×3)");
  });

  it("says nothing about occurrences on a first one", async () => {
    withItems([mItem({ occurrences: 1 })]);
    expect((await computeNotifications()).items[0].summary).toBe("next 16.0.9 → 16.1.0");
  });

  it("does not count an item the owner has already read", async () => {
    // The badge is driven by this count, so an item older than notif_read_at must
    // not relight it.
    vi.mocked(prisma.siteSetting.findUnique).mockResolvedValue({
      key: "notif_read_at",
      value: "2026-07-30T12:00:00Z",
    } as never);
    withItems([mItem({ createdAt: at("2026-07-30T10:00:00Z") })]);
    const res = await computeNotifications();
    expect(res.items).toHaveLength(1);
    expect(res.count).toBe(0);
  });
});
