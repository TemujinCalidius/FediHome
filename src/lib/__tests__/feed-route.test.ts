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

/** The web UI authenticates with the owner cookie; a native app uses a bearer token. */
const asCookie = () => authenticateApiRequest.mockResolvedValue({ ok: true, via: "cookie", scope: "*" });
const asBearer = () => authenticateApiRequest.mockResolvedValue({ ok: true, via: "bearer", scope: "read" });

const whereOf = () =>
  (vi.mocked(prisma.fediPost.findMany).mock.calls[0][0]?.where ?? {}) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  asCookie();
  vi.mocked(prisma.fediPost.findMany).mockResolvedValue([] as never);
});

describe("auth", () => {
  it("401s without a read scope", async () => {
    authenticateApiRequest.mockResolvedValue({ ok: false });
    expect((await GET(req())).status).toBe(401);
  });
});

describe("Bluesky rows default by who is asking (#393, #407)", () => {
  it("INCLUDES them for the web UI", async () => {
    // The regression that shipped in v1.23.0: defaulting to exclude for everyone
    // meant the web feed showed Bluesky posts on the server-rendered first paint
    // and then lost them the moment the client re-fetched — which it does on
    // load-more, on a filter toggle, and on a periodic silent refresh. The
    // release notes said Bluesky posts show. They didn't, reliably.
    asCookie();
    await GET(req());
    expect(whereOf()).not.toHaveProperty("source");
  });

  it("EXCLUDES them for a native app", async () => {
    // A client that decodes `apId` as a required string fails the whole response
    // rather than one row, so its feed goes blank rather than partial.
    asBearer();
    await GET(req());
    expect(whereOf().source).toBe("fedi");
  });

  it("lets an app opt in once it can handle a null apId", async () => {
    asBearer();
    await GET(req("?bluesky=1"));
    expect(whereOf()).not.toHaveProperty("source");
  });

  it("lets the web UI opt out too, so the flag isn't one-way", async () => {
    asCookie();
    await GET(req("?bluesky=0"));
    expect(whereOf().source).toBe("fedi");
  });

  it("keeps the existing default filters untouched", async () => {
    // Replies and boosts were already opt-in; the Bluesky default must not have
    // changed how the first two behave.
    asBearer();
    await GET(req());
    expect(whereOf()).toMatchObject({ inReplyTo: null, boostedBy: null, source: "fedi" });
  });

  it("composes with the other toggles rather than overriding them", async () => {
    asBearer();
    await GET(req("?replies=1&boosts=1&bluesky=1"));
    const where = whereOf();
    expect(where).not.toHaveProperty("inReplyTo");
    expect(where).not.toHaveProperty("boostedBy");
    expect(where).not.toHaveProperty("source");
  });

  it("treats an explicit non-1 value as off, whoever is asking", async () => {
    for (const v of ["0", "true", "yes", ""]) {
      vi.clearAllMocks();
      vi.mocked(prisma.fediPost.findMany).mockResolvedValue([] as never);
      asCookie();
      await GET(req(`?bluesky=${v}`));
      expect(whereOf().source, `?bluesky=${v}`).toBe("fedi");
    }
  });
});
