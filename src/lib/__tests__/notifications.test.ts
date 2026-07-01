import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    post: { findFirst: vi.fn() },
    photo: { findFirst: vi.fn() },
    fediPost: { findFirst: vi.fn() },
  },
}));

import { resolveOwnedTarget } from "../notifications";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.post.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.photo.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.fediPost.findFirst).mockResolvedValue(null as never);
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
