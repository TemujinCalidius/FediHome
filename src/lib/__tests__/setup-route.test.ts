import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * /api/setup (#59). The bug this locks down: `setupDone: true` used to be claimed
 * BEFORE `.env.local` was written, so any failure in between left an instance
 * permanently redirecting to /setup with no ADMIN_SECRET and no file-free
 * recovery. Order must now be validate → claim → write → roll back on failure.
 */

const { create, updateMany, findUnique, settingCreate } = vi.hoisted(() => ({
  create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(), settingCreate: vi.fn(),
}));
vi.mock("@/generated/prisma/client", () => ({
  PrismaClient: class {
    siteSettings = { create, updateMany };
    siteSetting = { findUnique, create: settingCreate };
  },
}));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class {} }));
vi.mock("@/lib/auth", () => ({ verifyAdmin: vi.fn(), safeCompare: (a: string, b: string) => a === b }));
vi.mock("@/lib/site-settings", () => ({ applySiteConfig: vi.fn().mockResolvedValue({ ok: true }) }));

const { writeFileSync, readFileSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(), readFileSync: vi.fn(),
}));
vi.mock("fs", () => ({ writeFileSync, readFileSync, default: { writeFileSync, readFileSync } }));

import { POST } from "@/app/api/setup/route";

const OLD_ADMIN = process.env.ADMIN_SECRET;
const OLD_TOKEN = process.env.SETUP_TOKEN;
const SECRET = "a".repeat(64);

const req = (body: Record<string, unknown>) =>
  new Request("https://demo.example/api/setup", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

const validBody = (over: Record<string, unknown> = {}) => ({
  siteName: "My Site", authorName: "Me", authorTagline: "", fediHandle: "me",
  contactEmail: "", adminSecret: SECRET, siteUrl: "https://demo.example",
  setupToken: "tok", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ADMIN_SECRET; // fresh deploy → setup-token branch
  process.env.SETUP_TOKEN = "tok";
  create.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 1 });
  readFileSync.mockReturnValue("");
  writeFileSync.mockReturnValue(undefined);
});
afterEach(() => {
  if (OLD_ADMIN === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = OLD_ADMIN;
  if (OLD_TOKEN === undefined) delete process.env.SETUP_TOKEN; else process.env.SETUP_TOKEN = OLD_TOKEN;
});

describe("/api/setup — first-claim gate", () => {
  it("rejects a wrong/missing setup token without claiming or writing", async () => {
    expect((await POST(req(validBody({ setupToken: "wrong" })))).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe("/api/setup — SITE_URL validation (#59)", () => {
  const rejected = [
    ["javascript: scheme", "javascript:alert(1)"],
    ["no scheme", "demo.example"],
    ["ftp scheme", "ftp://demo.example"],
    ["credentials", "https://user:pw@demo.example"],
    ["a path", "https://demo.example/blog"],
    ["a query", "https://demo.example/?x=1"],
  ] as const;

  for (const [label, value] of rejected) {
    it(`rejects ${label} with 400, never claiming or writing`, async () => {
      const res = await POST(req(validBody({ siteUrl: value })));
      expect(res.status).toBe(400); // NOT a 500 — these are caller-fixable
      expect(create).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    });
  }

  it("falls back to the request origin when siteUrl is omitted (documented chain)", async () => {
    const res = await POST(req(validBody({ siteUrl: "" })));
    expect(res.status).toBe(200);
    expect(writeFileSync.mock.calls[0][1] as string).toContain('SITE_URL="https://demo.example"');
  });

  it("accepts a clean origin, normalizes it, and derives FEDI_DOMAIN from it", async () => {
    const res = await POST(req(validBody({ siteUrl: "https://demo.example:8443/" })));
    expect(res.status).toBe(200);
    const written = writeFileSync.mock.calls[0][1] as string;
    expect(written).toContain('SITE_URL="https://demo.example:8443"'); // trailing slash dropped, port kept
    expect(written).toContain('FEDI_DOMAIN="demo.example:8443"');
    expect(written).toContain(`ADMIN_SECRET="${SECRET}"`);
  });
});

describe("/api/setup — claim ordering + rollback (the bricking fix)", () => {
  it("validates BEFORE claiming: a bad payload leaves setupDone untouched", async () => {
    const res = await POST(req(validBody({ adminSecret: "not-hex" })));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("claims BEFORE writing, and writes the env file on success", async () => {
    const res = await POST(req(validBody()));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("rolls the claim back when the .env.local write fails (no bricked install)", async () => {
    writeFileSync.mockImplementation(() => { throw new Error("EACCES: read-only file system"); });
    const res = await POST(req(validBody()));
    expect(res.status).toBe(500);
    // The claim must be released so setup can be retried.
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "main" }, data: { setupDone: false } });
    expect((await res.json()).error).toMatch(/writable/i);
  });

  it("returns 403 when setup was already completed (claim lost), without writing", async () => {
    create.mockRejectedValue(new Error("unique violation")); // row exists
    updateMany.mockResolvedValue({ count: 0 }); // ...and setupDone was already true
    const res = await POST(req(validBody()));
    expect(res.status).toBe(403);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
