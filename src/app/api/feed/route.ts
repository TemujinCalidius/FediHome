import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";
import { sanitizeHtml } from "@/lib/sanitize";
import { parseCursor, cursorWhere, encodeCursor, CURSOR_ORDER } from "@/lib/cursor";
import { blockedPostFilter } from "@/lib/blocks";

const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  // Owner cookie OR a `read`-scoped bearer token (a native app). Read-only → no CSRF.
  const auth = await authenticateApiRequest(req, "read");
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cursor = parseCursor(req.nextUrl.searchParams.get("cursor")); // "<iso>_<id>"
  const showReplies = req.nextUrl.searchParams.get("replies") === "1";
  const showBoosts = req.nextUrl.searchParams.get("boosts") === "1";
  // Bluesky posts (#393) default by WHO IS ASKING, because the two callers need
  // opposite answers and neither should have to remember to say so:
  //
  //   cookie  → our own web UI, which renders Bluesky posts, and whose
  //             server-rendered first page already includes them. Include.
  //   bearer  → a native app. Importing Bluesky posts made `apId` nullable, and
  //             a client that decodes it as a required string fails the WHOLE
  //             response rather than one row, so its feed goes blank rather than
  //             partial. Exclude until it asks (#407).
  //
  // Keying on the auth mode rather than a query flag is deliberate: the first
  // attempt at this defaulted to excluding for everyone, and the web client had
  // FOUR fetch paths. Three of them forgot the flag, so Bluesky posts appeared on
  // first paint and vanished the moment anything re-fetched. A default the caller
  // has to opt out of, rather than into, cannot drift like that.
  //
  // `?bluesky=1` / `?bluesky=0` still override, either way.
  // Tracked in #408; the app-side change is FediHome-macOS#73.
  const blueskyParam = req.nextUrl.searchParams.get("bluesky");
  const showBluesky = blueskyParam === null ? auth.via === "cookie" : blueskyParam === "1";

  const where: Record<string, unknown> = {};
  if (cursor) {
    Object.assign(where, cursorWhere(cursor));
  }
  if (!showReplies) {
    where.inReplyTo = null;
  }
  if (!showBoosts) {
    where.boostedBy = null;
  }
  if (!showBluesky) {
    where.source = "fedi";
  }

  // Feed provenance (#460), unconditional — not behind showReplies. A reply
  // pulled in by expanding a thread is just as much someone else's content as
  // the root is, and the thread view reads it by conversationId regardless, so
  // nothing the owner asked to see is lost by keeping both out of the feed.
  where.viaLookup = false;

  // Blocked actors, filtered on the way OUT as well as at ingest (#459).
  // /timeline and /fediverse both did this; this route did not — so the SSR first
  // paint hid a blocked account and every client refetch brought it back. Load
  // more, a filter toggle, the silent periodic refresh: all of them come through
  // here, so blocking held for the length of one screen. Native app clients read
  // this route exclusively, so they never filtered at all.
  //
  // Assign rather than spread into the literal: `where` may already carry `OR`
  // from the cursor, and this contributes `NOT`. Different keys, no collision.
  Object.assign(where, await blockedPostFilter());

  const posts = await prisma.fediPost.findMany({
    where,
    orderBy: CURSOR_ORDER,
    take: PAGE_SIZE + 1, // fetch one extra to check if there's more
  });

  const hasMore = posts.length > PAGE_SIZE;
  const page = hasMore ? posts.slice(0, PAGE_SIZE) : posts;
  // Re-sanitize contentHtml on every emit (protects against any legacy rows
  // stored before sanitization was tightened).
  const safePage = page.map((p) => ({
    ...p,
    contentHtml: p.contentHtml ? sanitizeHtml(p.contentHtml) : null,
  }));
  const last = page[page.length - 1];
  const nextCursor = hasMore ? encodeCursor(last.publishedAt, last.id) : null;

  return NextResponse.json({
    posts: JSON.parse(JSON.stringify(safePage)),
    nextCursor,
  });
}
