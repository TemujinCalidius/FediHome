import { NextRequest, NextResponse } from "next/server";
import { getIdentity } from "@/lib/identity";

export async function GET(req: NextRequest) {
  const resource = req.nextUrl.searchParams.get("resource");
  // One derivation, shared with the rest of the app (#326). This route used to
  // resolve identity on its own — `FEDI_DOMAIN || "localhost"` — so an instance
  // that set SITE_URL but not FEDI_DOMAIN advertised @you@yourdomain everywhere
  // while WebFinger answered only to acct:you@localhost. Every remote lookup got
  // a 404 and the site looked perfectly healthy from the inside: undiscoverable,
  // unfollowable, no error anywhere. Identity must come from one place.
  const { siteUrl, webfingerSubject: expected, actorId } = getIdentity();

  if (resource !== expected) {
    return NextResponse.json(
      { error: "resource not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(
    {
      subject: expected,
      aliases: [actorId],
      links: [
        {
          rel: "self",
          type: "application/activity+json",
          href: actorId,
        },
        {
          rel: "http://webfinger.net/rel/profile-page",
          type: "text/html",
          href: siteUrl,
        },
      ],
    },
    {
      headers: {
        "Content-Type": "application/jrd+json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}
