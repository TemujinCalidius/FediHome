import { NextResponse } from "next/server";
import { getActorProfile } from "@/lib/federation";
import { siteConfig } from "@/../site.config";

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
    return NextResponse.redirect(siteConfig.url, 302);
  }

  const actor = await getActorProfile();

  return NextResponse.json(actor, {
    headers: {
      "Content-Type": "application/activity+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      Vary: "Accept",
    },
  });
}
