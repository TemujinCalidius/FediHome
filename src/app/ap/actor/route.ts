import { NextResponse } from "next/server";
import { getActorProfile } from "@/lib/federation";
import { getSiteUrl } from "@/lib/identity";

export async function GET(req: Request) {
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
