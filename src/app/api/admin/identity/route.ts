import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifySameOriginRequest } from "@/lib/auth";
import {
  identityIsLocked,
  setIdentity,
  refreshIdentity,
  siteUrlShape,
  HANDLE_RE,
  DOMAIN_RE,
} from "@/lib/identity-store";
import { getIdentity } from "@/lib/identity";
import { isLocalOrPrivateHost } from "@/lib/public-host";

/**
 * Your federation identity — site URL, handle and domain (#326).
 *
 * These have always been environment-only, which makes an instance impossible to
 * stand up without file access to the host. They live in the database now, but
 * **only until the instance has published anything**.
 *
 * That limit isn't caution, it's arithmetic. `Post.apId` and friends are
 * `@unique` ABSOLUTE URLs built from `SITE_URL`, and every remote server that
 * has seen this actor keeps the first id it saw. Once either exists, changing
 * the address orphans your posts rather than moving them, and the copies that
 * matter aren't ours to rewrite. Moving domains after that needs the real
 * ActivityPub handshake — `alsoKnownAs` plus a `Move` served from the OLD
 * instance while it's still reachable (#347).
 *
 * Cookie-only (`verifyAdmin`, no bearer path), like `/api/admin/aliases`: an app
 * token must never be able to rewrite who this site claims to be.
 */

/** Same rules as the setup wizard — an identity the fediverse can't reach. */
function validateSiteUrl(input: string): { ok: true; value: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: "That isn't a valid URL. Include https:// at the start." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, error: "Use an http:// or https:// address." };
  }
  if (u.username || u.password) return { ok: false, error: "Remove the credentials from that URL." };
  if (u.pathname !== "/" || u.search || u.hash) {
    return { ok: false, error: "Use just the origin — no path, query or fragment." };
  }
  // Shape is decided by identity-store, which is also what the LOAD path uses
  // (#431). Same rule set, so the two can't drift; the reachability check below
  // stays here, because it applies to what an operator may set rather than to
  // what we are willing to load.
  if (!siteUrlShape(input)) {
    return { ok: false, error: "Use just the origin — no path, query or fragment." };
  }
  if (isLocalOrPrivateHost(u.hostname)) {
    return {
      ok: false,
      error: "That address can't be reached from the fediverse, so nobody could follow you there.",
    };
  }
  return { ok: true, value: u.origin };
}



export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = getIdentity();
  const lock = await identityIsLocked();
  return NextResponse.json({
    siteUrl: id.siteUrl,
    fediHandle: id.fediHandle,
    fediDomain: id.fediDomain,
    fediAddress: id.fediAddress,
    locked: lock.locked,
    lockedReason: lock.reason ?? null,
  });
}

export async function POST(req: NextRequest) {
  // Admin FIRST, origin second — the reverse of every other route, and deliberate.
  // This route uses verifySameOriginRequest so a wrong SITE_URL can be repaired
  // (#426); verifyOrigin would 403 here precisely when the value needs fixing,
  // including on this route. That check is weaker — a hostname an attacker points
  // at this server is same-origin to the browser — so the admin cookie, which is
  // scoped to the real hostname and cannot travel to such a host, has to be
  // established first. Ordering is what makes the relaxed check safe here.
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!verifySameOriginRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Checked before anything is written, and again by the UI on load. A 409 here
  // is the normal, expected answer for any instance that's actually in use.
  const lock = await identityIsLocked();
  if (lock.locked) {
    return NextResponse.json({ error: lock.reason }, { status: 409 });
  }

  const body = await req.json().catch(() => null);
  const patch: { siteUrl?: string; fediHandle?: string; fediDomain?: string } = {};

  if (typeof body?.siteUrl === "string" && body.siteUrl.trim() !== "") {
    const v = validateSiteUrl(body.siteUrl.trim());
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    patch.siteUrl = v.value;
  }

  if (typeof body?.fediHandle === "string" && body.fediHandle.trim() !== "") {
    const h = body.fediHandle.trim().replace(/^@/, "");
    if (!HANDLE_RE.test(h)) {
      return NextResponse.json(
        { error: "Handles can use letters, numbers and underscores, up to 30 characters." },
        { status: 400 },
      );
    }
    patch.fediHandle = h;
  }

  if (typeof body?.fediDomain === "string" && body.fediDomain.trim() !== "") {
    const d = body.fediDomain.trim().toLowerCase().replace(/\.+$/, "");
    if (!DOMAIN_RE.test(d)) {
      return NextResponse.json({ error: "That doesn't look like a domain name." }, { status: 400 });
    }
    patch.fediDomain = d;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  await setIdentity(patch);
  // Process-local — see identity-store. This refreshes the worker that handled
  // the request; the UI tells the owner to restart, which is the only way to be
  // sure every worker agrees.
  await refreshIdentity();

  const id = getIdentity();
  return NextResponse.json({
    success: true,
    siteUrl: id.siteUrl,
    fediHandle: id.fediHandle,
    fediDomain: id.fediDomain,
    fediAddress: id.fediAddress,
    restartRequired: true,
  });
}
