import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Logging in by DID rather than handle (#448).
 *
 * This is the safety mechanism the domain-handle feature rests on, not a detail.
 * In AT Protocol the handle is a **mutable alias** and the DID is the stable
 * identifier — so the moment an owner points their Bluesky handle at their own
 * domain, the stored `name.bsky.social` stops resolving and every login that used
 * it fails.
 *
 * Worse, it fails *late*. The session is cached for 30 minutes, so crossposting
 * keeps working right up until the cache expires, and then breaks for a reason
 * that looks nothing like "I changed my handle half an hour ago".
 *
 * There used to be fourteen places that logged in, each passing
 * `creds.did ?? handle` for itself. Since #541 there are two: this shared agent,
 * and `testBlueskyLogin` for the Test button. The fallback is unchanged, so
 * env-configured instances behave exactly as before until a DID is captured —
 * there is simply only one copy of it left to get wrong.
 */

const { getBlueskyCredentials, rememberBlueskyDid, normalizeBlueskyHandle } = vi.hoisted(() => ({
  getBlueskyCredentials: vi.fn(),
  rememberBlueskyDid: vi.fn(),
  normalizeBlueskyHandle: (h: string) => h.replace(/^@/, "").toLowerCase(),
}));
vi.mock("@/lib/integrations", () => ({
  getBlueskyCredentials,
  rememberBlueskyDid,
  normalizeBlueskyHandle,
  BLUESKY_SERVICE: "https://bsky.social",
  // The agent resolves the PDS per login now (#449) — the service is part of the
  // session cache key, so this mock has to supply it.
  blueskyService: async () => "https://bsky.social",
}));

const login = vi.fn();
vi.mock("@atproto/api", () => ({
  BskyAgent: class {
    session: { did: string } | undefined;
    login = async (opts: { identifier: string; password: string }) => {
      this.session = { did: "did:plc:captured" };
      return login(opts);
    };
  },
}));

import { getBlueskyAgent } from "@/lib/bluesky-agent";

const DID = "did:plc:stable123";

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("which identifier is used", () => {
  it("logs in with the DID when one is stored", async () => {
    getBlueskyCredentials.mockResolvedValue({ handle: "me.bsky.social", password: "p", did: DID });
    const { getBlueskyAgent: fresh } = await import("@/lib/bluesky-agent");
    await fresh();
    expect(login).toHaveBeenCalledWith(expect.objectContaining({ identifier: DID }));
  });

  it("falls back to the handle when no DID is stored", async () => {
    // Existing installs and env-configured instances must behave exactly as before.
    getBlueskyCredentials.mockResolvedValue({ handle: "me.bsky.social", password: "p" });
    const { getBlueskyAgent: fresh } = await import("@/lib/bluesky-agent");
    await fresh();
    expect(login).toHaveBeenCalledWith(expect.objectContaining({ identifier: "me.bsky.social" }));
  });

  it("captures the DID on first login so the fallback is only ever used once", async () => {
    getBlueskyCredentials.mockResolvedValue({ handle: "me.bsky.social", password: "p" });
    const { getBlueskyAgent: fresh } = await import("@/lib/bluesky-agent");
    await fresh();
    expect(rememberBlueskyDid).toHaveBeenCalledWith("did:plc:captured");
  });

  it("does not re-persist a DID it was already given", async () => {
    getBlueskyCredentials.mockResolvedValue({ handle: "me.bsky.social", password: "p", did: DID });
    const { getBlueskyAgent: fresh } = await import("@/lib/bluesky-agent");
    await fresh();
    expect(rememberBlueskyDid).not.toHaveBeenCalled();
  });
});

describe("the session cache", () => {
  it("is keyed on the identifier actually used, not the handle", async () => {
    // Otherwise a stored DID and a bare handle would share a cache entry, and
    // changing credentials could hand back a session for the previous identity.
    getBlueskyCredentials.mockResolvedValue({ handle: "me.bsky.social", password: "p", did: DID });
    const { getBlueskyAgent: fresh } = await import("@/lib/bluesky-agent");
    await fresh();
    await fresh();
    expect(login).toHaveBeenCalledTimes(1); // second call served from cache
  });
});

// Keeps the import referenced for lint without affecting the resetModules dance.
void getBlueskyAgent;
