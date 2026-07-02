import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import type { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    authorizationCode: { findUnique: vi.fn(), deleteMany: vi.fn() },
    authToken: { create: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { POST as tokenPOST } from "@/app/api/oauth/token/route";
import { POST as revokePOST } from "@/app/api/oauth/revoke/route";
import { prisma } from "@/lib/db";
import { hashToken, sweepExpiredAuthTokens } from "@/lib/auth";

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function formReq(url: string, fields: Record<string, string>): NextRequest {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }) as unknown as NextRequest;
}

const REDIRECT = "fedihome-macos://callback";

function validRecord(challenge: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    codeHash: "h",
    clientId: "fedihome-macos",
    redirectUri: REDIRECT,
    scope: "read create",
    codeChallenge: challenge,
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

function exchange(fields: Partial<Record<string, string>> = {}, verifier = "v") {
  return formReq("https://x/api/oauth/token", {
    grant_type: "authorization_code",
    code: "the-code",
    redirect_uri: REDIRECT,
    client_id: "fedihome-macos",
    code_verifier: verifier,
    ...fields,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SITE_URL = "https://demo.example";
  delete process.env.APP_TOKEN_TTL_DAYS;
  vi.mocked(prisma.authorizationCode.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.authToken.create).mockResolvedValue({} as never);
  vi.mocked(prisma.authToken.deleteMany).mockResolvedValue({ count: 1 } as never);
});

describe("POST /api/oauth/token", () => {
  it("rejects an unsupported grant_type", async () => {
    const res = await tokenPOST(exchange({ grant_type: "password" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });

  it("rejects an unknown client", async () => {
    const res = await tokenPOST(exchange({ client_id: "evil" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("rejects missing code / verifier / redirect", async () => {
    const res = await tokenPOST(exchange({ code: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });

  it("invalid_grant for an unknown code", async () => {
    vi.mocked(prisma.authorizationCode.findUnique).mockResolvedValue(null as never);
    const res = await tokenPOST(exchange());
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("invalid_grant + burns an expired code", async () => {
    const { verifier, challenge } = pkcePair();
    vi.mocked(prisma.authorizationCode.findUnique).mockResolvedValue(
      validRecord(challenge, { expiresAt: new Date(Date.now() - 1000) }) as never,
    );
    const res = await tokenPOST(exchange({}, verifier));
    expect((await res.json()).error).toBe("invalid_grant");
    expect(prisma.authorizationCode.deleteMany).toHaveBeenCalledTimes(1); // burn
    expect(prisma.authToken.create).not.toHaveBeenCalled();
  });

  it("invalid_grant on client / redirect mismatch", async () => {
    const { verifier, challenge } = pkcePair();
    vi.mocked(prisma.authorizationCode.findUnique).mockResolvedValue(
      validRecord(challenge, { redirectUri: "fedihome-macos://other" }) as never,
    );
    const res = await tokenPOST(exchange({}, verifier));
    expect((await res.json()).error).toBe("invalid_grant");
    expect(prisma.authToken.create).not.toHaveBeenCalled();
  });

  it("invalid_grant when the PKCE verifier is wrong", async () => {
    const { challenge } = pkcePair();
    vi.mocked(prisma.authorizationCode.findUnique).mockResolvedValue(validRecord(challenge) as never);
    const res = await tokenPOST(exchange({}, pkcePair().verifier)); // different verifier
    expect((await res.json()).error).toBe("invalid_grant");
    expect(prisma.authToken.create).not.toHaveBeenCalled();
  });

  it("mints a scoped oauth token on the happy path", async () => {
    const { verifier, challenge } = pkcePair();
    vi.mocked(prisma.authorizationCode.findUnique).mockResolvedValue(validRecord(challenge) as never);
    const res = await tokenPOST(exchange({}, verifier));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", scope: "read create", me: "https://demo.example" });
    expect(typeof body.access_token).toBe("string");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(prisma.authToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: "read create",
          clientId: "fedihome-macos",
          createdVia: "oauth",
          expiresAt: null,
        }),
      }),
    );
  });

  it("invalid_grant when the code was already consumed (race)", async () => {
    const { verifier, challenge } = pkcePair();
    vi.mocked(prisma.authorizationCode.findUnique).mockResolvedValue(validRecord(challenge) as never);
    vi.mocked(prisma.authorizationCode.deleteMany).mockResolvedValue({ count: 0 } as never);
    const res = await tokenPOST(exchange({}, verifier));
    expect((await res.json()).error).toBe("invalid_grant");
    expect(prisma.authToken.create).not.toHaveBeenCalled();
  });

  it("refuses to mint when the stored scope was tampered to include an invalid scope", async () => {
    const { verifier, challenge } = pkcePair();
    vi.mocked(prisma.authorizationCode.findUnique).mockResolvedValue(
      validRecord(challenge, { scope: "read admin" }) as never, // 'admin' isn't a real scope
    );
    const res = await tokenPOST(exchange({}, verifier));
    expect((await res.json()).error).toBe("invalid_grant");
    expect(prisma.authToken.create).not.toHaveBeenCalled();
    expect(prisma.authorizationCode.deleteMany).toHaveBeenCalled(); // code burned
  });

  it("rejects an over-large body before parsing (413)", async () => {
    const big = {
      headers: {
        get: (n: string) =>
          n === "content-length" ? "99999" : n === "content-type" ? "application/json" : null,
      },
    } as unknown as NextRequest;
    const res = await tokenPOST(big);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("invalid_request");
    expect(prisma.authorizationCode.findUnique).not.toHaveBeenCalled();
  });
  it("sets expiresAt when APP_TOKEN_TTL_DAYS is configured", async () => {
    process.env.APP_TOKEN_TTL_DAYS = "30";
    const { verifier, challenge } = pkcePair();
    vi.mocked(prisma.authorizationCode.findUnique).mockResolvedValue(validRecord(challenge) as never);
    await tokenPOST(exchange({}, verifier));
    const data = vi.mocked(prisma.authToken.create).mock.calls[0]?.[0]?.data as
      | { expiresAt?: unknown }
      | undefined;
    expect(data?.expiresAt).toBeInstanceOf(Date);
  });

  it("sweepExpiredAuthTokens deletes rows whose expiry has passed", async () => {
    vi.mocked(prisma.authToken.deleteMany).mockResolvedValue({ count: 2 } as never);
    const n = await sweepExpiredAuthTokens(true);
    expect(n).toBe(2);
    const arg = vi.mocked(prisma.authToken.deleteMany).mock.calls.at(-1)?.[0];
    expect(arg?.where?.expiresAt).toHaveProperty("lt");
  });
});

describe("POST /api/oauth/revoke", () => {
  it("deletes the matching token and returns 200", async () => {
    const res = await revokePOST(formReq("https://x/api/oauth/revoke", { token: "sekret" }));
    expect(res.status).toBe(200);
    expect(prisma.authToken.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: hashToken("sekret") },
    });
  });

  it("returns 200 without touching the DB when no token is given", async () => {
    const res = await revokePOST(formReq("https://x/api/oauth/revoke", {}));
    expect(res.status).toBe(200);
    expect(prisma.authToken.deleteMany).not.toHaveBeenCalled();
  });
});
