import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { verifyAdmin, verifyOrigin } = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  verifyOrigin: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  verifyAdmin,
  verifyOrigin,
  hashToken: (t: string) => "h:" + t,
  safeCompare: () => false,
}));
vi.mock("@/lib/db", () => ({
  prisma: { authorizationCode: { create: vi.fn(), deleteMany: vi.fn() } },
}));

import { GET, POST } from "@/app/api/oauth/authorize/route";
import { prisma } from "@/lib/db";

const VALID: Record<string, string> = {
  client_id: "fedihome-macos",
  redirect_uri: "fedihome-macos://callback",
  scope: "read create bogus", // → sanitizes to "read create"
  state: "xyz",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
  response_type: "code",
};

function getReq(qs: Record<string, string>): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(qs) },
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

function postReq(fields: Record<string, string>): NextRequest {
  return new Request("https://x/api/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  vi.mocked(prisma.authorizationCode.create).mockResolvedValue({} as never);
  vi.mocked(prisma.authorizationCode.deleteMany).mockResolvedValue({ count: 0 } as never);
});

describe("GET /api/oauth/authorize — validation & rendering", () => {
  it("error page for an unknown client (no redirect)", async () => {
    const res = await GET(getReq({ ...VALID, client_id: "evil" }));
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("Unknown application");
  });

  it("error page for an unregistered redirect URI", async () => {
    const res = await GET(getReq({ ...VALID, redirect_uri: "https://evil.com/cb" }));
    expect(await res.text()).toContain("redirect URI");
  });

  it("error page for a non-code response_type", async () => {
    const res = await GET(getReq({ ...VALID, response_type: "token" }));
    expect(await res.text()).toContain("response_type");
  });

  it("error page when PKCE isn't S256", async () => {
    const res = await GET(getReq({ ...VALID, code_challenge_method: "plain" }));
    expect(await res.text()).toContain("S256");
  });

  it("renders the login page when there's no admin session", async () => {
    verifyAdmin.mockResolvedValue(false);
    const html = await (await GET(getReq(VALID))).text();
    expect(html).toContain("Sign in");
    expect(html).toContain("FediHome for macOS");
  });

  it("renders the consent page (with sanitized scopes) when logged in", async () => {
    verifyAdmin.mockResolvedValue(true);
    const html = await (await GET(getReq(VALID))).text();
    expect(html).toContain("Authorize");
    expect(html).toContain("Create posts"); // the `create` scope label
    expect(html).not.toContain("bogus"); // dropped by sanitizeScope
    expect(html).toContain('value="fedihome-macos://callback"'); // hidden redirect field
  });
});

describe("POST /api/oauth/authorize — consent decision", () => {
  it("rejects a bad origin (CSRF)", async () => {
    verifyOrigin.mockReturnValue(false);
    const html = await (await POST(postReq({ ...VALID, decision: "approve" }))).text();
    expect(html).toContain("origin");
    expect(prisma.authorizationCode.create).not.toHaveBeenCalled();
  });

  it("mints a code and returns to the app on approve", async () => {
    verifyOrigin.mockReturnValue(true);
    verifyAdmin.mockResolvedValue(true);
    const res = await POST(postReq({ ...VALID, decision: "approve" }));
    const html = await res.text();
    expect(html).toContain("code="); // return link carries the code
    expect(html).toContain("state=xyz");
    expect(prisma.authorizationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: "fedihome-macos",
          redirectUri: "fedihome-macos://callback",
          scope: "read create",
          codeChallenge: "a".repeat(43),
        }),
      }),
    );
  });

  it("returns access_denied on deny (no code minted)", async () => {
    verifyOrigin.mockReturnValue(true);
    verifyAdmin.mockResolvedValue(true);
    const html = await (await POST(postReq({ ...VALID, decision: "deny" }))).text();
    expect(html).toContain("error=access_denied");
    expect(prisma.authorizationCode.create).not.toHaveBeenCalled();
  });

  it("error page if a tampered hidden field carries an unknown client", async () => {
    verifyOrigin.mockReturnValue(true);
    verifyAdmin.mockResolvedValue(true);
    const html = await (await POST(postReq({ ...VALID, client_id: "evil", decision: "approve" }))).text();
    expect(html).toContain("Unknown application");
    expect(prisma.authorizationCode.create).not.toHaveBeenCalled();
  });
});
