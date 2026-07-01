import { NextRequest, NextResponse } from "next/server";
import { hashToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { rateLimitKey } from "@/lib/client-ip";
import { makeRateLimiter, bodyTooLarge } from "@/lib/oauth";

/**
 * OAuth 2.0 Token Revocation (RFC 7009). A client revokes its own bearer token.
 *
 * Public client called machine-to-machine (no browser cookie) → deliberately NO
 * CSRF/origin check, exactly like the token endpoint: the bearer token IS the
 * credential (it isn't an ambient cookie a forged request could ride), and a
 * same-origin check would instead break the native app, which sends no browser
 * Origin. Per §2.2 the endpoint returns 200 regardless of whether the token
 * existed, so a caller can't probe validity. (The owner can also revoke from the
 * Connected-apps dashboard.)
 */

const revokeLimiter = makeRateLimiter(20, 60_000);

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
  if (!revokeLimiter.check(rateLimitKey(req), Date.now())) {
    return NextResponse.json({ error: "temporarily_unavailable" }, { status: 429 });
  }
  if (bodyTooLarge(req)) {
    return new NextResponse(null, { status: 413 });
  }

  const body = await parseBody(req);
  const token = body.token;
  if (token) {
    await prisma.authToken
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => {});
  }
  // Always 200 — never reveal whether the token existed.
  return new NextResponse(null, { status: 200 });
}
