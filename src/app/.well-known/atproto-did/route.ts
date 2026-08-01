import { NextResponse } from "next/server";
import { getBlueskyCredentials } from "@/lib/integrations";
import { getRuntimeSiteConfig } from "@/lib/site-settings";

/**
 * `/.well-known/atproto-did` — proves to Bluesky that this domain is yours (#448).
 *
 * AT Protocol lets an account use a domain it controls as its handle, verified
 * one of two ways: a DNS TXT record at `_atproto.<domain>`, or this endpoint
 * returning the account's DID. FediHome already serves the domain, so it can
 * supply the proof directly and the owner never touches DNS.
 *
 * What this is NOT: it does not make FediHome a Bluesky host. The account still
 * lives on Bluesky; this relabels it. The DID is what actually identifies the
 * account — the handle is a mutable alias — so nothing is lost in the change:
 * followers, follows and posts are all recorded against the DID, and Bluesky
 * reserves the old `*.bsky.social` handle rather than releasing it.
 *
 * **Opt-in, always.** Serving this is *claiming an identity*, so it stays off
 * until the owner asks for it — never inferred from Bluesky merely being
 * configured. A 404 while disabled is also the correct answer: it is exactly what
 * a domain not making the claim looks like.
 *
 * Format is unforgiving and both halves are common failure modes: `text/plain`,
 * and **no trailing newline**. Bluesky compares the body exactly.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = await getRuntimeSiteConfig();
  if (!cfg.blueskyDomainHandle) {
    return new NextResponse("not found", { status: 404 });
  }

  const creds = await getBlueskyCredentials();
  // No DID captured yet means nobody has logged in since the feature existed.
  // Answering 404 is honest — we cannot prove a claim we do not have.
  if (!creds?.did) {
    return new NextResponse("not found", { status: 404 });
  }

  return new NextResponse(creds.did, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Short: this is the record Bluesky re-checks to keep the handle valid, and
      // a stale copy after the owner turns the feature off would keep asserting a
      // claim the instance no longer makes.
      "Cache-Control": "public, max-age=300",
    },
  });
}
