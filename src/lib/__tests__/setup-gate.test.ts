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
