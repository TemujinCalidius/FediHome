import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateBlueskyService, BLUESKY_SERVICE } from "@/lib/integrations";

/**
 * #449. `const SERVICE = "https://bsky.social"` decided which AT Protocol server
 * FediHome could talk to at all. AT Protocol is deliberately multi-host: an
 * operator who migrates to a self-hosted PDS keeps their DID, posts and
 * followers, but their PDS hostname changes — and FediHome then couldn't
 * authenticate them, for the sake of one string.
 */
describe("validateBlueskyService", () => {
  it("accepts a bare https origin", () => {
    expect(validateBlueskyService("https://pds.example.com")).toBe("https://pds.example.com");
    expect(validateBlueskyService("https://pds.example.com/")).toBe("https://pds.example.com");
    expect(validateBlueskyService("  https://pds.example.com  ")).toBe("https://pds.example.com");
  });

  it("keeps a non-default port — a self-hosted PDS often has one", () => {
    expect(validateBlueskyService("https://pds.example.com:2583")).toBe("https://pds.example.com:2583");
  });

  it("refuses http — credentials are posted to this host", () => {
    expect(validateBlueskyService("http://pds.example.com")).toBeNull();
  });

  it("refuses a host that can't federate", () => {
    // Same rule that guards the site URL, and the same helper rather than a
    // second opinion that could drift from it.
    for (const v of ["https://localhost", "https://127.0.0.1", "https://192.168.1.5", "https://10.0.0.1"]) {
      expect(validateBlueskyService(v), v).toBeNull();
    }
  });

  it("refuses embedded credentials and anything past the origin", () => {
    for (const v of [
      "https://user:pw@pds.example.com",
      "https://pds.example.com/xrpc",
      "https://pds.example.com/?a=1",
    ]) {
      expect(validateBlueskyService(v), v).toBeNull();
    }
  });

  it("refuses junk rather than throwing", () => {
    for (const v of ["", "not a url", "javascript:alert(1)"]) {
      expect(validateBlueskyService(v), v).toBeNull();
    }
  });
});

describe("blueskyService — resolution and fallback", () => {
  const load = async (row: string | undefined, env?: string) => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      prisma: {
        siteSetting: {
          findMany: vi.fn().mockResolvedValue(
            row === undefined ? [] : [{ key: "integration.bluesky.service", value: row }],
          ),
        },
      },
    }));
    if (env === undefined) delete process.env.BLUESKY_SERVICE;
    else process.env.BLUESKY_SERVICE = env;
    return import("@/lib/integrations");
  };
  beforeEach(() => vi.resetModules());

  it("defaults to bsky.social, so nothing changes for anyone who never sets it", async () => {
    const { blueskyService } = await load(undefined);
    expect(await blueskyService()).toBe(BLUESKY_SERVICE);
  });

  it("uses a stored PDS origin", async () => {
    const { blueskyService } = await load("https://pds.example.com");
    expect(await blueskyService()).toBe("https://pds.example.com");
  });

  it("falls back rather than throwing on an invalid stored row", async () => {
    // A bad row must not take crossposting down; the admin route validates on
    // the way in, so this is the belt to that pair of braces.
    const { blueskyService } = await load("not a url");
    expect(await blueskyService()).toBe(BLUESKY_SERVICE);
  });

  it("reads the environment when there is no row", async () => {
    const { blueskyService } = await load(undefined, "https://env-pds.example.com");
    expect(await blueskyService()).toBe("https://env-pds.example.com");
    delete process.env.BLUESKY_SERVICE;
  });
});

describe("the session cache is keyed on the service (#449)", () => {
  it("does not reuse a session logged in to a different PDS", async () => {
    // The failure mode this prevents is silent: a stale agent keeps WORKING, so
    // the symptom is posts going to the wrong host rather than an error.
    vi.resetModules();
    const login = vi.fn().mockResolvedValue(undefined);
    const services: (string | undefined)[] = [];
    vi.doMock("@atproto/api", () => ({
      BskyAgent: class {
        session = { did: "did:plc:abc" };
        constructor(o: { service: string }) { services.push(o.service); }
        login = login;
      },
    }));
    let service = "https://one.example";
    vi.doMock("@/lib/integrations", () => ({
      blueskyService: async () => service,
      getBlueskyCredentials: async () => ({ handle: "me.example", password: "pw", did: "did:plc:abc" }),
      normalizeBlueskyHandle: (h: string) => h,
      rememberBlueskyDid: vi.fn(),
    }));
    const { getBlueskyAgent } = await import("@/lib/bluesky-agent");

    await getBlueskyAgent();
    await getBlueskyAgent();
    expect(login).toHaveBeenCalledTimes(1); // same service → cached

    service = "https://two.example";
    await getBlueskyAgent();
    expect(login).toHaveBeenCalledTimes(2); // changed → re-login
    expect(services).toEqual(["https://one.example", "https://two.example"]);
  });
});
