import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const resource = req.nextUrl.searchParams.get("resource");
  const domain = process.env.FEDI_DOMAIN || "localhost";
  const handle = process.env.FEDI_HANDLE || "me";
  const siteUrl = process.env.SITE_URL || `https://${domain}`;

  const expected = `acct:${handle}@${domain}`;

  if (resource !== expected) {
    return NextResponse.json(
      { error: "resource not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(
    {
      subject: expected,
      aliases: [`${siteUrl}/ap/actor`],
      links: [
        {
          rel: "self",
          type: "application/activity+json",
          href: `${siteUrl}/ap/actor`,
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
