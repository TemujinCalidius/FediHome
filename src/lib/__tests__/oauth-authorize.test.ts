import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

/**
 * A pass-through spy, so the real resolution still runs and only the RATE KEY it
 * is handed becomes observable. That key is the pre-auth outbound-fetch budget
 * for IndieAuth `client_id` resolution (#494) — where a shared or forged key is
 * an egress-abuse primitive, not merely a way to retry.
 */
const { resolveClientSpy } = vi.hoisted(() => ({ resolveClientSpy: vi.fn() }));
vi.mock("@/lib/oauth-clients", async (orig) => {
  const actual = await orig<typeof import("@/lib/oauth-clients")>();
  return {
    ...actual,
    resolveClient: (...args: Parameters<typeof actual.resolveClient>) => {
      resolveClientSpy(...args);
      return actual.resolveClient(...args);
    },
  };
});

import { GET, POST } from "@/app/api/oauth/authorize/route";
import { SHARED_BUCKET_KEY } from "@/lib/client-ip";
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

function getReq(qs: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(qs) },
    cookies: { get: () => undefined },
    // A real NextRequest always has these. Leaving them off worked only because
    // `rateLimitKey` returns before touching them when no proxy is trusted — so
    // on every reverse-proxied install, which is the DOCUMENTED deployment, this
    // whole file threw `Cannot read properties of undefined (reading 'get')`
    // instead of testing anything. Six tests, invisible on a bare laptop.
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

function postReq(fields: Record<string, string>): NextRequest {
  return new Request("https://x/api/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }) as unknown as NextRequest;
}

afterEach(() => {
  // test-setup.ts clears these once per FILE; a test that sets them owes the
  // next test the same clean slate.
  delete process.env.TRUSTED_PROXY;
  delete process.env.TRUSTED_PROXY_HEADER;
});

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
    // The message now names the constraint rather than implying a malformed
    // client_id (#486) — this instance only accepts its own apps.
    expect(await res.text()).toContain("couldn&#39;t be verified");
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

/**
 * The branch no test had ever entered. `rateLimitKey` short-circuits to the
 * shared bucket unless TRUSTED_PROXY=true, so on a maintainer's laptop GET never
 * reached the header read — and the fake request had no headers to read.
 *
 * That is not a cosmetic gap. The key threaded into `validate` is spent inside
 * `resolveClient` on cache misses, and telling one visitor from another is the
 * entire point of that budget. Un-proxied it is one bucket for the internet;
 * proxied it is per visitor, and only the second shape is the one deployments
 * actually run.
 */
describe("the pre-auth fetch budget is keyed by the visitor (#494)", () => {
  it("uses the forwarded address behind a trusted proxy", async () => {
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "x-real-ip";
    await GET(getReq(VALID, { "x-real-ip": "203.0.113.7" }));
    expect(resolveClientSpy).toHaveBeenCalledWith("fedihome-macos", "203.0.113.7");
  });

  it("tells two visitors apart, so one cannot spend the other's budget", async () => {
    process.env.TRUSTED_PROXY = "true";
    process.env.TRUSTED_PROXY_HEADER = "x-real-ip";
    await GET(getReq(VALID, { "x-real-ip": "203.0.113.7" }));
    await GET(getReq(VALID, { "x-real-ip": "198.51.100.4" }));
    expect(resolveClientSpy.mock.calls.map((c) => c[1])).toEqual(["203.0.113.7", "198.51.100.4"]);
  });

  it("collapses to one shared bucket when no proxy is trusted", async () => {
    // Stricter, not laxer: without a trusted edge the header is spoofable, so
    // honouring it would let one caller mint unlimited budgets.
    await GET(getReq(VALID, { "x-real-ip": "203.0.113.7" }));
    expect(resolveClientSpy).toHaveBeenCalledWith("fedihome-macos", SHARED_BUCKET_KEY);
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
    expect(html).toContain("couldn&#39;t be verified");
    expect(prisma.authorizationCode.create).not.toHaveBeenCalled();
  });
});
