import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * `/api/feed` — the endpoint the native apps read.
 *
 * It had no test coverage, which is how #393 broke the macOS client: importing
 * Bluesky posts made `FediPost.apId` nullable, and this route spreads whole rows
 * (`...p`). A client that decodes `apId` as a required string then fails the
 * **entire response**, not the one offending row — so the feed went blank the
 * moment a single Bluesky post entered a page, rather than degrading.
 *
 * Bluesky rows are therefore excluded unless the caller opts in. The contract
 * these tests pin is: **an existing client sees exactly what it saw before.**
 */

const { authenticateApiRequest } = vi.hoisted(() => ({ authenticateApiRequest: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authenticateApiRequest }));
vi.mock("@/lib/sanitize", () => ({ sanitizeHtml: (s: string) => s }));
vi.mock("@/lib/db", () => ({ prisma: { fediPost: { findMany: vi.fn() } } }));

import { GET } from "@/app/api/feed/route";
import { prisma } from "@/lib/db";

const req = (qs = ""): NextRequest => {
  const url = new URL(`https://demo.example/api/feed${qs}`);
  return { nextUrl: url, url: url.toString(), headers: new Headers() } as unknown as NextRequest;
};

const whereOf = () =>
  (vi.mocked(prisma.fediPost.findMany).mock.calls[0][0]?.where ?? {}) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  authenticateApiRequest.mockResolvedValue({ ok: true });
  vi.mocked(prisma.fediPost.findMany).mockResolvedValue([] as never);
});

describe("auth", () => {
  it("401s without a read scope", async () => {
    authenticateApiRequest.mockResolvedValue({ ok: false });
    expect((await GET(req())).status).toBe(401);
  });
});

describe("Bluesky rows are opt-in, so existing clients keep working (#393)", () => {
  it("excludes them by default", async () => {
    await GET(req());
    expect(whereOf().source).toBe("fedi");
  });

  it("includes them only when asked", async () => {
    await GET(req("?bluesky=1"));
    expect(whereOf()).not.toHaveProperty("source");
  });

  it("keeps the existing default filters untouched", async () => {
    // Replies and boosts were already opt-in; adding a third toggle must not
    // change how the first two behave.
    await GET(req());
    expect(whereOf()).toMatchObject({ inReplyTo: null, boostedBy: null, source: "fedi" });
  });

  it("composes with the other toggles rather than overriding them", async () => {
    await GET(req("?replies=1&boosts=1&bluesky=1"));
    const where = whereOf();
    expect(where).not.toHaveProperty("inReplyTo");
    expect(where).not.toHaveProperty("boostedBy");
    expect(where).not.toHaveProperty("source");
  });

  it("treats any value other than 1 as off", async () => {
    // No accidental opt-in from `?bluesky=true` or `?bluesky=0`.
    for (const v of ["0", "true", "yes", ""]) {
      vi.clearAllMocks();
      vi.mocked(prisma.fediPost.findMany).mockResolvedValue([] as never);
      await GET(req(`?bluesky=${v}`));
      expect(whereOf().source, `?bluesky=${v}`).toBe("fedi");
    }
  });
});
