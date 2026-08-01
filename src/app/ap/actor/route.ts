import { NextResponse } from "next/server";
import { getActorProfile } from "@/lib/federation";
import { getIdentity, getSiteUrl } from "@/lib/identity";

export async function GET(req: Request) {
  // When the proxy rewrote /users/<handle>, check the handle was ours (#429).
  // Previously /users/<anything> served this document to any AP request, so the
  // instance answered for handles it does not have — a crawler enumerating
  // /users/* got a valid actor for every guess. The HTML route has always done
  // this check; the AP path did not.
  //
  // Decided here rather than in the proxy because getIdentity() is authoritative
  // here: identity overrides are process-local and loaded at boot, so the proxy
  // would see only `process.env` and 404 the actor of any DB-configured handle.
  const requested = new URL(req.url).searchParams.get("handle");
  if (requested !== null && requested !== getIdentity().fediHandle) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Content negotiation: ActivityPub clients get the actor JSON; browsers asking
  // for HTML get redirected to the human-facing profile (the actor's `url`), so
  // "view profile" links don't dump raw JSON.
  const accept = req.headers.get("accept") || "";
  const wantsAp =
    accept.includes("application/activity+json") ||
    accept.includes("application/ld+json");
  const wantsHtml = accept.includes("text/html");
  if (wantsHtml && !wantsAp) {
    // Resolved identity, not the import-time siteConfig snapshot: site.config.ts
    // evaluates getIdentity() at module load, so a DB-backed identity override
    // (#326) may not be reflected there. Everything else here uses the live one.
    return NextResponse.redirect(getSiteUrl(), 302);
  }

  const actor = await getActorProfile();

  return NextResponse.json(actor, {
    headers: {
      "Content-Type": "application/activity+json; charset=utf-8",
      // Short, deliberately. A remote server verifying an account move fetches
      // this document to check `alsoKnownAs`; an hour-stale copy means the move
      // is refused and the followers silently stay behind (#326).
      "Cache-Control": "public, max-age=300",
      Vary: "Accept",
    },
  });
}
