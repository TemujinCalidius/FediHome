import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getIdentity, getSiteUrl, getConfiguredSiteUrl } from "@/lib/identity";

/**
 * Federation identity (#326 Phase 0). The failure mode these guard is silent:
 * if the actor id, the WebFinger subject and the signature keyId stop agreeing,
 * remote servers quietly stop resolving and verifying us while every response
 * we serve still looks well-formed. Nothing logs an error — you just become
 * unfollowable.
 */

const OLD = {
  SITE_URL: process.env.SITE_URL,
  FEDI_HANDLE: process.env.FEDI_HANDLE,
  FEDI_DOMAIN: process.env.FEDI_DOMAIN,
};

beforeEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEDI_HANDLE;
  delete process.env.FEDI_DOMAIN;
});

afterAll(() => {
  for (const [k, v] of Object.entries(OLD)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("getIdentity — the pieces must agree", () => {
  it("derives actor id, keyId and WebFinger subject from one source", () => {
    process.env.SITE_URL = "https://example.com";
    process.env.FEDI_HANDLE = "me";
    process.env.FEDI_DOMAIN = "example.com";

    const id = getIdentity();
    expect(id.actorId).toBe("https://example.com/ap/actor");
    // The keyId MUST be the actor id plus the fragment — a remote server fetches
    // the actor and looks for publicKey.id matching this exactly.
    expect(id.keyId).toBe(`${id.actorId}#main-key`);
    expect(id.webfingerSubject).toBe("acct:me@example.com");
    expect(id.fediAddress).toBe("@me@example.com");
  });

  it("keeps keyId anchored to actorId whatever the site URL is", () => {
    for (const url of ["https://a.example", "https://b.example:8443", "http://localhost:3000"]) {
      process.env.SITE_URL = url;
      const id = getIdentity();
      expect(id.keyId.startsWith(id.actorId)).toBe(true);
    }
  });
});

describe("getIdentity — the WebFinger divergence this replaced", () => {
  it("derives the domain from SITE_URL when FEDI_DOMAIN is unset", () => {
    // The old WebFinger route defaulted to the literal "localhost" instead, so an
    // instance that set only SITE_URL advertised @me@example.com everywhere while
    // WebFinger answered acct:me@localhost — 404 to every remote lookup.
    process.env.SITE_URL = "https://example.com";
    const id = getIdentity();
    expect(id.fediDomain).toBe("example.com");
    expect(id.webfingerSubject).toBe("acct:me@example.com");
  });

  it("keeps a non-default port in the derived domain", () => {
    // Dropping the port would send remote lookups to :443, which isn't us.
    process.env.SITE_URL = "https://example.com:8443";
    expect(getIdentity().fediDomain).toBe("example.com:8443");
  });

  it("an explicit FEDI_DOMAIN still wins", () => {
    process.env.SITE_URL = "https://internal.example";
    process.env.FEDI_DOMAIN = "public.example";
    expect(getIdentity().fediDomain).toBe("public.example");
    expect(getIdentity().webfingerSubject).toBe("acct:me@public.example");
  });
});

describe("getIdentity — normalisation", () => {
  it("strips trailing slashes so the actor id can't gain a double slash", () => {
    // An actor id differing by one slash is a DIFFERENT id to a remote server.
    process.env.SITE_URL = "https://example.com/";
    expect(getSiteUrl()).toBe("https://example.com");
    expect(getIdentity().actorId).toBe("https://example.com/ap/actor");
  });

  it("falls back to localhost:3000 when nothing is configured", () => {
    const id = getIdentity();
    expect(id.siteUrl).toBe("http://localhost:3000");
    expect(id.fediDomain).toBe("localhost:3000");
  });

  it("survives a malformed SITE_URL without throwing", () => {
    process.env.SITE_URL = "not a url";
    expect(() => getIdentity()).not.toThrow();
  });
});

describe("getConfiguredSiteUrl", () => {
  it("returns undefined when unset — no localhost default", () => {
    // Setup uses this to decide what to WRITE; a localhost default there would
    // beat the far better guess of the request's own origin.
    expect(getConfiguredSiteUrl()).toBeUndefined();
  });

  it("returns the normalised configured value when set", () => {
    process.env.SITE_URL = "https://example.com/";
    expect(getConfiguredSiteUrl()).toBe("https://example.com");
  });
});
