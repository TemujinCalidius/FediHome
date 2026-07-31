import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { NextRequest } from "next/server";

/**
 * `/api/admin/password` — set or change the admin password.
 *
 * The library beneath it is well covered (`password.test.ts`), but the **route**
 * had no test at all: not the re-auth, not the migration branch that accepts
 * `ADMIN_SECRET` as the current credential, not the session revocation. That
 * matters more now that #411 sends owners here from the sign-in screen — this is
 * the destination, so its contract should be pinned.
 *
 * The behaviour worth protecting is the re-auth. A valid session alone must not
 * be enough to change the password: an unattended browser shouldn't be able to
 * lock the owner out of their own site.
 */

const { verifyAdmin, verifyOrigin, sessionIdFromCookie } = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  verifyOrigin: vi.fn(),
  sessionIdFromCookie: vi.fn(),
}));
vi.mock("@/lib/auth", async () => {
  const crypto = await import("crypto");
  return {
    verifyAdmin,
    verifyOrigin,
    sessionIdFromCookie,
    // The real constant-time compare — the migration branch depends on it.
    safeCompare: (a: string, b: string) => {
      const ab = Buffer.from(a ?? "", "utf8");
      const bb = Buffer.from(b ?? "", "utf8");
      return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
    },
  };
});

const { getPasswordHash, verifyPassword, setPassword, hasPassword } = vi.hoisted(() => ({
  getPasswordHash: vi.fn(),
  verifyPassword: vi.fn(),
  setPassword: vi.fn(),
  hasPassword: vi.fn(),
}));
vi.mock("@/lib/password", async (orig) => ({
  // Real validatePassword — the minimum-length contract is part of what's tested.
  ...(await orig<Record<string, unknown>>()),
  getPasswordHash,
  verifyPassword,
  setPassword,
  hasPassword,
}));
vi.mock("@/lib/db", () => ({ prisma: { adminSession: { deleteMany: vi.fn() } } }));

import { GET, POST } from "@/app/api/admin/password/route";
import { prisma } from "@/lib/db";

const SECRET = "s".repeat(64);
const HASH = "scrypt$16384$8$1$c2FsdA==$aGFzaA==";
const OLD_SECRET = process.env.ADMIN_SECRET;

const req = (body?: unknown, cookie = "sid.mac"): NextRequest =>
  ({
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
    cookies: { get: () => ({ value: cookie }) },
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_SECRET = SECRET;
  verifyAdmin.mockResolvedValue(true);
  verifyOrigin.mockReturnValue(true);
  sessionIdFromCookie.mockReturnValue("sid");
  getPasswordHash.mockResolvedValue(HASH);
  verifyPassword.mockResolvedValue(true);
  setPassword.mockResolvedValue(undefined);
  hasPassword.mockResolvedValue(true);
  vi.mocked(prisma.adminSession.deleteMany).mockResolvedValue({ count: 2 } as never);
});

afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = OLD_SECRET;
});

describe("GET", () => {
  it("reports whether a password is set, and never the hash", async () => {
    hasPassword.mockResolvedValue(true);
    const res = await GET(req());
    const body = await res.json();
    expect(body).toEqual({ hasPassword: true });
    expect(JSON.stringify(body)).not.toContain("scrypt");
  });

  it("401s without an admin session", async () => {
    verifyAdmin.mockResolvedValue(false);
    expect((await GET(req())).status).toBe(401);
  });
});

describe("gates", () => {
  it("403s on a cross-origin request, before checking auth", async () => {
    verifyOrigin.mockReturnValue(false);
    expect((await POST(req({ currentPassword: "x", newPassword: "y".repeat(12) }))).status).toBe(403);
    expect(verifyAdmin).not.toHaveBeenCalled();
  });

  it("401s without an admin session", async () => {
    verifyAdmin.mockResolvedValue(false);
    expect((await POST(req({ currentPassword: "x", newPassword: "y".repeat(12) }))).status).toBe(401);
  });
});

describe("re-authentication", () => {
  it("changes the password when the current one is right", async () => {
    const res = await POST(req({ currentPassword: "old password here", newPassword: "new password here" }));
    expect(res.status).toBe(200);
    expect(setPassword).toHaveBeenCalledWith("new password here");
  });

  it("REFUSES on a valid session alone when the current password is wrong", async () => {
    // The point of re-auth: an unattended browser must not be able to lock the
    // owner out of their own site.
    verifyPassword.mockResolvedValue(false);
    const res = await POST(req({ currentPassword: "wrong", newPassword: "new password here" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/current password is incorrect/i);
    expect(setPassword).not.toHaveBeenCalled();
  });

  it("accepts ADMIN_SECRET as the current credential when no password is set yet", async () => {
    // The migration case #411 exists to end: the owner has only ever had the key.
    getPasswordHash.mockResolvedValue(null);
    const res = await POST(req({ currentPassword: SECRET, newPassword: "new password here" }));
    expect(res.status).toBe(200);
    expect(setPassword).toHaveBeenCalled();
  });

  it("says 'admin secret' rather than 'password' in that case's error", async () => {
    getPasswordHash.mockResolvedValue(null);
    const res = await POST(req({ currentPassword: "not the secret", newPassword: "new password here" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/admin secret/i);
  });

  it("refuses everything when there is neither a hash nor an ADMIN_SECRET", async () => {
    getPasswordHash.mockResolvedValue(null);
    delete process.env.ADMIN_SECRET;
    expect((await POST(req({ currentPassword: "", newPassword: "new password here" }))).status).toBe(401);
  });

  it("rejects a non-string current credential rather than coercing it", async () => {
    getPasswordHash.mockResolvedValue(null);
    expect((await POST(req({ currentPassword: { $ne: null }, newPassword: "new password here" }))).status).toBe(401);
  });
});

describe("validation", () => {
  it("400s a too-short new password, before touching anything", async () => {
    const res = await POST(req({ currentPassword: "old password here", newPassword: "short" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/12 characters/);
    expect(setPassword).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("400s a missing new password", async () => {
    expect((await POST(req({ currentPassword: "old password here" }))).status).toBe(400);
  });

  it("400s a non-JSON body instead of throwing a 500", async () => {
    expect((await POST(req(undefined))).status).toBe(400);
  });
});

describe("session revocation", () => {
  it("signs out other devices but keeps the current session", async () => {
    // Changing a password is the standard way to evict someone who shouldn't
    // still be signed in — but logging yourself out in the process would be rude.
    const res = await POST(req({ currentPassword: "old password here", newPassword: "new password here" }));
    expect(prisma.adminSession.deleteMany).toHaveBeenCalledWith({ where: { id: { not: "sid" } } });
    expect((await res.json()).otherSessionsRevoked).toBe(2);
  });

  it("revokes everything when the current session id can't be parsed", async () => {
    sessionIdFromCookie.mockReturnValue(null);
    await POST(req({ currentPassword: "old password here", newPassword: "new password here" }));
    expect(prisma.adminSession.deleteMany).toHaveBeenCalledWith({ where: {} });
  });

  it("still reports success if revocation fails — the password did change", async () => {
    vi.mocked(prisma.adminSession.deleteMany).mockRejectedValue(new Error("db down") as never);
    const res = await POST(req({ currentPassword: "old password here", newPassword: "new password here" }));
    expect(res.status).toBe(200);
    expect((await res.json()).otherSessionsRevoked).toBe(0);
  });
});
