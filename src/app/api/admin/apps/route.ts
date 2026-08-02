import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin, generateToken } from "@/lib/auth";
import { sanitizeScope, appTokenExpiry, isValidTtlDays } from "@/lib/oauth";

/**
 * Connected-apps management (#158). Lets the owner revoke the bearer tokens that
 * apps hold — OAuth app tokens and hand-issued Micropub tokens alike.
 *
 *   { action: "revoke", id }  — delete one AuthToken (id = its cuid)
 *   { action: "revoke-all" }  — delete every AuthToken
 *
 * Deleting a row invalidates that bearer on its next request (verifyMicropubToken
 * no longer finds it). Guarded by both CSRF origin and admin auth.
 */
export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  // Mint a scoped bearer token out of band (#255) — for clients that accept a
  // pasted token (headless/CI, App Store review, read-only readers) without the
  // OAuth/ADMIN_SECRET dance. The RAW token is returned exactly once; only its
  // sha256 hash is stored (generateToken), so it can't be read back later — a
  // lost token is revoked + reissued.
  //
  // The lifetime is now chosen per token (#327). Before that this branch passed
  // no expiry at all, so every admin-generated token was permanent — and the
  // global `security.appTokenTtlDays` that the settings screen advertises never
  // reached them, because the arithmetic was private to the OAuth route. An
  // operator who set that global had half their tokens quietly ignore it.
  if (action === "create") {
    const rawLabel = typeof body?.label === "string" ? body.label.trim() : "";
    if (rawLabel.length > 100 || /[\r\n]/.test(rawLabel)) {
      return NextResponse.json({ error: "invalid label" }, { status: 400 });
    }
    const scope = sanitizeScope(typeof body?.scope === "string" ? body.scope : "");
    if (!scope) {
      return NextResponse.json({ error: "pick at least one scope" }, { status: 400 });
    }
    // Absent means "use the instance default", NOT "never" — which is what makes
    // the global finally apply here. That default ships as 0 (site.config.ts), so
    // nothing changes for anyone who has not deliberately set it; an operator who
    // HAS set it is getting the behaviour the setting already promised.
    // An explicit value must be a whole number of days; 0 is valid and means
    // never. null is rejected rather than treated as a choice, since 0 already
    // says that and two spellings of one thing is how they drift apart.
    let ttlDays: number;
    if (body?.ttlDays === undefined) {
      const { getRuntimeSiteConfig } = await import("@/lib/site-settings");
      ttlDays = (await getRuntimeSiteConfig()).security.appTokenTtlDays;
    } else if (isValidTtlDays(body.ttlDays)) {
      ttlDays = body.ttlDays;
    } else {
      return NextResponse.json({ error: "invalid expiry" }, { status: 400 });
    }

    const expiresAt = appTokenExpiry(ttlDays);
    const token = await generateToken(rawLabel || "Generated token", {
      scope,
      createdVia: "manual",
      expiresAt,
    });
    return NextResponse.json({
      success: true,
      token,
      label: rawLabel || "Generated token",
      scope,
      // Returned so the one-time reveal can state the lifetime. It is the only
      // moment the operator sees the token, so it is the only moment worth
      // telling them when it dies.
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
  }

  // Third-party OAuth client registration (#366). A registration is the only way
  // a custom-scheme redirect (obsidian://, raycast://) can be trusted — nothing
  // about a scheme proves who owns it, so the owner asserting it IS the security
  // model. That is also why IndieAuth alone cannot serve these clients: it
  // authenticates a client by URL, and a custom scheme has none.
  if (action === "register_client") {
    const { registerClient } = await import("@/lib/oauth-clients");
    const r = await registerClient(
      typeof body?.clientId === "string" ? body.clientId : "",
      typeof body?.label === "string" ? body.label : "",
      Array.isArray(body?.redirectUris) ? body.redirectUris.filter((u: unknown) => typeof u === "string") : [],
    );
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ success: true });
  }

  if (action === "unregister_client") {
    const { unregisterClient } = await import("@/lib/oauth-clients");
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id || id.length > 64) return NextResponse.json({ error: "invalid id" }, { status: 400 });
    await unregisterClient(id);
    return NextResponse.json({ success: true });
  }

  if (action === "revoke") {
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id || id.length > 64) {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }
    // deleteMany (not delete) so a stale/already-revoked id is a no-op, not a throw.
    const result = await prisma.authToken.deleteMany({ where: { id } });
    return NextResponse.json({ success: true, revoked: result.count });
  }

  if (action === "revoke-all") {
    const result = await prisma.authToken.deleteMany({});
    return NextResponse.json({ success: true, revoked: result.count });
  }

  // Tighten/adjust a token's scopes without re-auth. Only recognised scopes
  // persist (sanitizeScope), and an empty result is rejected so a token can't be
  // left scopeless. A reduced scope takes effect on the token's next request
  // (authenticateApiRequest reads the scope live).
  if (action === "edit_scopes") {
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id || id.length > 64) {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }
    const scope = sanitizeScope(typeof body?.scope === "string" ? body.scope : "");
    if (!scope) {
      return NextResponse.json({ error: "invalid scope" }, { status: 400 });
    }
    const result = await prisma.authToken.updateMany({ where: { id }, data: { scope } });
    return NextResponse.json({ success: true, updated: result.count, scope });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
