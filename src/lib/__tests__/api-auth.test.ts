import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

vi.mock("@/lib/db", () => ({
  prisma: {
    authToken: { findUnique: vi.fn(), update: vi.fn() },
    adminSession: { findUnique: vi.fn(), delete: vi.fn(), update: vi.fn() },
  },
}));

import { authenticateApiRequest } from "../auth";
import { prisma } from "@/lib/db";

const ADMIN_SECRET = "test-admin-secret";

function req(opts: { bearer?: string; cookie?: string }) {
  const headers = new Map<string, string>();
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  return {
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    cookies: {
      get: (n: string) => (n === "sl_admin" && opts.cookie ? { value: opts.cookie } : undefined),
    },
  };
}

function validAdminCookie(): string {
  const sessionId = crypto.randomBytes(16).toString("hex");
  const mac = crypto.createHmac("sha256", ADMIN_SECRET).update(sessionId).digest("hex");
  return `${sessionId}.${mac}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  vi.mocked(prisma.authToken.update).mockResolvedValue({} as never);
  vi.mocked(prisma.adminSession.update).mockResolvedValue({} as never);
});

describe("authenticateApiRequest (#app-api unified auth)", () => {
  it("rejects a request with no bearer and no cookie", async () => {
    const r = await authenticateApiRequest(req({}));
    expect(r).toEqual({ ok: false, via: null, scope: "" });
  });

  it("accepts a valid bearer token that has the required scope", async () => {
    vi.mocked(prisma.authToken.findUnique).mockResolvedValue({ id: "t1", scope: "read create", expiresAt: null } as never);
    const r = await authenticateApiRequest(req({ bearer: "abc" }), "read");
    expect(r).toEqual({ ok: true, via: "bearer", scope: "read create" });
  });

  it("rejects a valid bearer token that LACKS the required scope (403 territory)", async () => {
    vi.mocked(prisma.authToken.findUnique).mockResolvedValue({ id: "t1", scope: "create", expiresAt: null } as never);
    const r = await authenticateApiRequest(req({ bearer: "abc" }), "read");
    expect(r).toMatchObject({ ok: false, via: "bearer" });
  });

  it("rejects an unknown bearer token", async () => {
    vi.mocked(prisma.authToken.findUnique).mockResolvedValue(null as never);
    const r = await authenticateApiRequest(req({ bearer: "nope" }), "read");
    expect(r).toEqual({ ok: false, via: null, scope: "" });
  });

  it("rejects an EXPIRED bearer token (and doesn't touch lastUsedAt)", async () => {
    vi.mocked(prisma.authToken.findUnique).mockResolvedValue({ id: "t1", scope: "read", expiresAt: new Date(Date.now() - 1000) } as never);
    const r = await authenticateApiRequest(req({ bearer: "abc" }), "read");
    expect(r).toEqual({ ok: false, via: null, scope: "" });
    expect(prisma.authToken.update).not.toHaveBeenCalled();
  });

  it("falls back to the owner admin cookie (full access, satisfies any scope)", async () => {
    vi.mocked(prisma.adminSession.findUnique).mockResolvedValue(
      { id: "s1", expiresAt: new Date(Date.now() + 60_000), lastUsedAt: new Date() } as never,
    );
    const r = await authenticateApiRequest(req({ cookie: validAdminCookie() }), "read");
    expect(r).toEqual({ ok: true, via: "cookie", scope: "*" });
  });

  it("prefers the bearer token over a cookie when both are present", async () => {
    vi.mocked(prisma.authToken.findUnique).mockResolvedValue({ id: "t1", scope: "read", expiresAt: null } as never);
    const r = await authenticateApiRequest(req({ bearer: "abc", cookie: validAdminCookie() }), "read");
    expect(r.via).toBe("bearer");
    expect(prisma.adminSession.findUnique).not.toHaveBeenCalled();
  });
});
