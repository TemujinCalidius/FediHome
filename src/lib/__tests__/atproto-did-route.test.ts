import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `/.well-known/atproto-did` — the proof that lets an owner use their own domain
 * as their Bluesky handle (#448).
 *
 * Bluesky compares the response body exactly, so the two things most likely to
 * break it are the content type and a trailing newline. Both are asserted here
 * because neither produces a useful error — the handle simply shows as
 * "Invalid handle" in the Bluesky app with nothing to explain why.
 */

const { getBlueskyCredentials } = vi.hoisted(() => ({ getBlueskyCredentials: vi.fn() }));
vi.mock("@/lib/integrations", () => ({ getBlueskyCredentials }));

const { getRuntimeSiteConfig } = vi.hoisted(() => ({ getRuntimeSiteConfig: vi.fn() }));
vi.mock("@/lib/site-settings", () => ({ getRuntimeSiteConfig }));

import { GET } from "@/app/.well-known/atproto-did/route";

const DID = "did:plc:abcdef1234567890";

beforeEach(() => {
  vi.clearAllMocks();
  getRuntimeSiteConfig.mockResolvedValue({ blueskyDomainHandle: true });
  getBlueskyCredentials.mockResolvedValue({ handle: "me.bsky.social", password: "p", did: DID });
});

describe("when the owner has opted in", () => {
  it("returns the DID as bare text/plain", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(DID);
  });

  it("has NO trailing newline — the single most common way this breaks", async () => {
    const body = await (await GET()).text();
    expect(body.endsWith("\n")).toBe(false);
    expect(body).toBe(body.trim());
  });
});

describe("when it should not answer", () => {
  it("404s while the feature is off", async () => {
    // Serving this claims an identity, so it stays off until asked for. A 404 is
    // also the honest answer: it is what a domain not making the claim looks like.
    getRuntimeSiteConfig.mockResolvedValue({ blueskyDomainHandle: false });
    expect((await GET()).status).toBe(404);
    expect(getBlueskyCredentials).not.toHaveBeenCalled();
  });

  it("404s when no DID has been captured yet", async () => {
    // An instance configured before this existed has a handle and password but no
    // DID. Asserting a claim we cannot substantiate would be worse than silence.
    getBlueskyCredentials.mockResolvedValue({ handle: "me.bsky.social", password: "p" });
    expect((await GET()).status).toBe(404);
  });

  it("404s when Bluesky isn't configured at all", async () => {
    getBlueskyCredentials.mockResolvedValue(null);
    expect((await GET()).status).toBe(404);
  });
});
