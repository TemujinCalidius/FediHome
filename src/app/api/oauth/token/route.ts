import { NextRequest, NextResponse } from "next/server";
import { hashToken, generateToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { rateLimitKey } from "@/lib/client-ip";
import { getClient, verifyPkceS256, makeRateLimiter, sanitizeScope, bodyTooLarge } from "@/lib/oauth";

/**
 * OAuth 2.0 / IndieAuth token endpoint. Exchanges a single-use, PKCE-bound
 * authorization code for a scoped bearer token.
 *
 * Called by the native app (a public client) directly — NOT from a browser form
 * — so there is no ambient cookie and no CSRF check. Authentication IS the code +
 * PKCE verifier. Token responses are never cached (RFC 6749 §5.1).
 */

const tokenLimiter = makeRateLimiter(20, 60_000);

function oauthError(error: string, description: string, status = 400): NextResponse {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}

async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await req.json().catch(() => null);
    return j && typeof j === "object" ? (j as Record<string, string>) : {};
  }
  const form = await req.formData().catch(() => null);
  const out: Record<string, string> = {};
  if (form) for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

export async function POST(req: NextRequest) {
  if (!tokenLimiter.check(rateLimitKey(req), Date.now())) {
    return oauthError("temporarily_unavailable", "Too many requests.", 429);
  }
  if (bodyTooLarge(req)) {
    return oauthError("invalid_request", "Request body too large.", 413);
  }

  const body = await parseBody(req);
  const grantType = body.grant_type;
  const codeValue = body.code;
  const redirectUri = body.redirect_uri;
  const clientId = body.client_id;
  const codeVerifier = body.code_verifier;

  if (grantType !== "authorization_code") {
    return oauthError("unsupported_grant_type", "Only authorization_code is supported.");
  }
  const client = getClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown client_id.", 401);
  if (!codeValue || !redirectUri || !codeVerifier) {
    return oauthError("invalid_request", "code, redirect_uri and code_verifier are required.");
  }

  const codeHash = hashToken(codeValue);
  const record = await prisma.authorizationCode.findUnique({ where: { codeHash } });

  // Any validation failure past this point burns the code (single attempt).
  const burn = () =>
    prisma.authorizationCode.deleteMany({ where: { codeHash } }).catch(() => {});

  // Same generic message for "never existed" and "expired" so the response can't
  // be used to distinguish which codes have previously been issued.
  if (!record) return oauthError("invalid_grant", "Invalid or expired authorization code.");
  if (record.expiresAt.getTime() < Date.now()) {
    await burn();
    return oauthError("invalid_grant", "Invalid or expired authorization code.");
  }
  if (record.clientId !== client.id || record.redirectUri !== redirectUri) {
    await burn();
    return oauthError("invalid_grant", "Client or redirect URI mismatch.");
  }
  if (!verifyPkceS256(codeVerifier, record.codeChallenge)) {
    await burn();
    return oauthError("invalid_grant", "PKCE verification failed.");
  }

  // Defence in depth: re-sanitize the stored scope right before minting. The
  // authorize endpoint only ever writes an already-sanitized scope, so a mismatch
  // means the row was tampered with out-of-band — refuse rather than mint it.
  const grantedScope = sanitizeScope(record.scope);
  if (!grantedScope || grantedScope !== record.scope) {
    await burn();
    return oauthError("invalid_grant", "Invalid authorization code.");
  }

  // Consume the code atomically — if another concurrent request already claimed
  // it, count is 0 and we must NOT mint a second token from one code.
  const consumed = await prisma.authorizationCode.deleteMany({ where: { codeHash } });
  if (consumed.count !== 1) {
    return oauthError("invalid_grant", "The authorization code has already been used.");
  }

  const accessToken = await generateToken(client.label, {
    scope: grantedScope,
    clientId: client.id,
    createdVia: "oauth",
    expiresAt: null, // long-lived + revocable (Connected apps), Mastodon-style
  });

  return NextResponse.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      scope: grantedScope,
      me: process.env.SITE_URL || "http://localhost:3000",
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}
