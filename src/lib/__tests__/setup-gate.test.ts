import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function req(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const base = `https://demo.example${pathname}`;
  return {
    nextUrl: {
      pathname,
      clone: () => new URL(base),
    },
    cookies: {
      get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined),
    },
    headers: { get: () => null },
  } as unknown as NextRequest;
}

const ORIGINAL = process.env.ADMIN_SECRET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIGINAL;
});

describe("proxy setup gates", () => {
  describe("configured instance (ADMIN_SECRET set)", () => {
    beforeEach(() => {
      process.env.ADMIN_SECRET = "x".repeat(64);
    });

    it("redirects /setup home — the wizard must not render once configured", () => {
      const res = proxy(req("/setup"));
      expect(res.headers.get("location")).toBe("https://demo.example/");
    });

    it("redirects /setup/anything too", () => {
      const res = proxy(req("/setup/step-2"));
      expect(res.headers.get("location")).toBe("https://demo.example/");
    });

    it("leaves normal pages alone", () => {
      const res = proxy(req("/timeline"));
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("fresh install (no ADMIN_SECRET)", () => {
    beforeEach(() => {
      delete process.env.ADMIN_SECRET;
    });

    it("still serves the wizard at /setup", () => {
      const res = proxy(req("/setup"));
      expect(res.headers.get("location")).toBeNull();
    });

    it("still forces other pages to /setup", () => {
      const res = proxy(req("/timeline"));
      expect(res.headers.get("location")).toBe("https://demo.example/setup");
    });

    it("respects the fedihome_setup cookie (post-wizard, pre-restart)", () => {
      const res = proxy(req("/timeline", { fedihome_setup: "done" }));
      expect(res.headers.get("location")).toBeNull();
    });
  });
});

/**
 * `/users/<handle>` content negotiation (#429).
 *
 * The proxy rewrote ANY `/users/…` path to the actor document for an AP request,
 * never reading the segment — so the instance answered for handles it does not
 * have, and a crawler enumerating `/users/*` got a valid actor for every guess.
 * The HTML route has always checked (`users/[username]/page.tsx`); the AP path
 * did not.
 *
 * The handle is carried through rather than compared here on purpose. Identity
 * overrides are process-local and populated only at boot, so this module would
 * see `process.env` alone — an instance whose handle lives in the database would
 * start 404-ing its own actor, which is worse than the bug. `/ap/actor` reads the
 * live identity and decides there.
 */
describe("proxy /users content negotiation", () => {
  const AP = { accept: "application/activity+json" };

  // Without this the setup gate above intercepts everything with a 307 to
  // /setup, and none of these branches is ever reached.
  beforeEach(() => {
    process.env.ADMIN_SECRET = "x".repeat(64);
  });

  /**
   * The setup-gate factory above takes cookies and hard-codes `headers.get` to
   * null, which these tests need to vary — hence a second one rather than
   * reworking a factory six passing tests depend on.
   */
  const apReq = (pathname: string, headers: Record<string, string>): NextRequest => {
    const base = `https://demo.example${pathname}`;
    return {
      nextUrl: { pathname, clone: () => new URL(base) },
      cookies: { get: () => undefined },
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    } as unknown as NextRequest;
  };

  it("rewrites an AP request to the actor, carrying the requested handle", () => {
    const res = proxy(apReq("/users/samuel", AP));
    const dest = new URL(res.headers.get("x-middleware-rewrite") ?? "http://x/none");
    expect(dest.pathname).toBe("/ap/actor");
    expect(dest.searchParams.get("handle")).toBe("samuel");
  });

  it("carries whatever was asked for, so the actor can reject it", () => {
    const res = proxy(apReq("/users/somebody-else", AP));
    const dest = new URL(res.headers.get("x-middleware-rewrite") ?? "http://x/none");
    expect(dest.searchParams.get("handle")).toBe("somebody-else");
  });

  it("does NOT rewrite a sub-path — the actor is the wrong document for it", () => {
    // /users/<handle>/followers used to land on the actor. Collections are /ap/*.
    for (const path of ["/users/samuel/followers", "/users/samuel/outbox", "/users/a/b/c"]) {
      const res = proxy(apReq(path, AP));
      expect(res.headers.get("x-middleware-rewrite"), path).toBeNull();
    }
  });

  it("does not rewrite a bare /users/ with no handle", () => {
    expect(proxy(apReq("/users/", AP)).headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("leaves a browser request alone, so the HTML profile still renders", () => {
    const res = proxy(apReq("/users/samuel", { accept: "text/html" }));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
