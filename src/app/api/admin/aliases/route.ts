import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { getAlsoKnownAs, setAlsoKnownAs } from "@/lib/identity-store";

/**
 * Account aliases — the `alsoKnownAs` list on our actor (#326).
 *
 * This is what lets someone move to a FediHome from another server **with their
 * followers**: the old server publishes a `Move`, and every receiving server
 * then fetches this actor and only re-points the follow if `alsoKnownAs` names
 * the old account. No alias, no move.
 *
 * Cookie-only (`verifyAdmin`, no bearer path), matching the other identity-
 * adjacent admin routes: an app token must never be able to claim that this
 * site is also some other account, which is the first half of an account
 * takeover.
 */

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ aliases: await getAlsoKnownAs() });
}

export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const raw = typeof body?.aliases === "string" ? body.aliases : null;
  if (raw === null) {
    return NextResponse.json({ error: "aliases must be a string" }, { status: 400 });
  }
  if (raw.length > 2000) {
    return NextResponse.json({ error: "That's too long to be an alias list." }, { status: 400 });
  }

  // Returns what was actually stored — entries that aren't absolute http(s)
  // URLs are dropped, so the caller can see if something didn't take rather
  // than believing a typo was saved.
  const aliases = await setAlsoKnownAs(raw);
  return NextResponse.json({ success: true, aliases });
}
