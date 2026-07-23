import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/.well-known/webfinger/route";

/**
 * WebFinger (#326 Phase 0). The bug this locks down: this route used to resolve
 * identity on its own — `FEDI_DOMAIN || "localhost"` — while the rest of the app
 * derived the domain from `SITE_URL`. On an instance that set `SITE_URL` but not
 * `FEDI_DOMAIN`, the site advertised `@me@example.com` on every page while
 * WebFinger only answered `acct:me@localhost`.
 *
 * The result was a site that looked completely healthy from the inside and was
 * undiscoverable from the outside: every remote lookup got a bare 404, so nobody
 * could follow it, and nothing anywhere logged a problem.
 */

const OLD = {
  SITE_URL: process.env.SITE_URL,
  FEDI_HANDLE: process.env.FEDI_HANDLE,
  FEDI_DOMAIN: process.env.FEDI_DOMAIN,
};

const lookup = (resource: string) =>
  GET(new NextRequest(`https://example.com/.well-known/webfinger?resource=${encodeURIComponent(resource)}`));

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

describe("WebFinger resolves the identity the site advertises", () => {
  it("answers for the SITE_URL-derived domain when FEDI_DOMAIN is unset (the regression)", async () => {
    process.env.SITE_URL = "https://example.com";
    process.env.FEDI_HANDLE = "me";

    const res = await lookup("acct:me@example.com");
    expect(res.status).toBe(200); // was 404 — undiscoverable

    const body = await res.json();
    expect(body.subject).toBe("acct:me@example.com");
    expect(body.links.find((l: { rel: string }) => l.rel === "self").href).toBe(
      "https://example.com/ap/actor",
    );
  });

  it("no longer answers to the bogus localhost identity it used to invent", async () => {
    process.env.SITE_URL = "https://example.com";
    process.env.FEDI_HANDLE = "me";
    expect((await lookup("acct:me@localhost")).status).toBe(404);
  });

  it("honours an explicit FEDI_DOMAIN that differs from the site host", async () => {
    process.env.SITE_URL = "https://internal.example";
    process.env.FEDI_DOMAIN = "public.example";
    process.env.FEDI_HANDLE = "me";

    expect((await lookup("acct:me@public.example")).status).toBe(200);
    expect((await lookup("acct:me@internal.example")).status).toBe(404);
  });

  it("keeps a non-default port in the advertised identity", async () => {
    process.env.SITE_URL = "https://example.com:8443";
    process.env.FEDI_HANDLE = "me";

    const res = await lookup("acct:me@example.com:8443");
    expect(res.status).toBe(200);
    expect((await res.json()).links[0].href).toBe("https://example.com:8443/ap/actor");
  });

  it("still 404s an unrelated account", async () => {
    process.env.SITE_URL = "https://example.com";
    process.env.FEDI_HANDLE = "me";
    expect((await lookup("acct:someone@elsewhere.example")).status).toBe(404);
  });

  it("the actor href it returns matches the actor id used for signing", async () => {
    process.env.SITE_URL = "https://example.com";
    process.env.FEDI_HANDLE = "me";

    const { getIdentity } = await import("@/lib/identity");
    const body = await (await lookup("acct:me@example.com")).json();
    const self = body.links.find((l: { rel: string }) => l.rel === "self").href;
    expect(self).toBe(getIdentity().actorId);
    expect(getIdentity().keyId).toBe(`${self}#main-key`);
  });
});
