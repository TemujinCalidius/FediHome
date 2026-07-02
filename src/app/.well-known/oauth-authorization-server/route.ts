import { NextResponse } from "next/server";
import { SUPPORTED_SCOPES } from "@/lib/oauth";

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414). Native FediHome apps fetch
 * this to discover the authorize/token/revoke endpoints and confirm that only
 * PKCE S256 + public clients are supported before starting the login flow.
 */
export async function GET() {
  const siteUrl = process.env.SITE_URL || "http://localhost:3000";

  return NextResponse.json(
    {
      issuer: siteUrl,
      authorization_endpoint: `${siteUrl}/api/oauth/authorize`,
      token_endpoint: `${siteUrl}/api/oauth/token`,
      revocation_endpoint: `${siteUrl}/api/oauth/revoke`,
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
    },
    // Short TTL so a SITE_URL / domain change propagates quickly (the doc's
    // endpoint URLs are all derived from SITE_URL).
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}
