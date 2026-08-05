import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";
import { sanitizeHtml } from "@/lib/sanitize";
import { parseCursor, cursorWhere, encodeCursor, CURSOR_ORDER } from "@/lib/cursor";
import { blockedPostFilter } from "@/lib/blocks";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { VIA_REPLY_PARENT } from "@/lib/explore";

/**
 * The Explore feed (#386): posts by people the owner does NOT follow, surfaced
 * because someone they DO follow boosted or replied to them.
 *
 * A separate route rather than a flag on /api/feed. The feed's shape —
 * `inReplyTo: null, boostedBy: null, viaLookup: false, discoveredVia: null` — is
 * a guarantee three surfaces make in identical terms and a test pins them
 * together, because every time two of them disagreed the symptom was a post
 * appearing on first paint and vanishing on refresh (#459, #460). Bolting a
 * fifth mode onto that query is how the guarantee stops being one.
 *
 * Owner-only, like /api/feed, and additionally gated on the setting: with
 * Explore off this answers 404 rather than an empty list, so a client can tell
 * "not enabled here" from "nothing found yet".
 */

const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  const auth = await authenticateApiRequest(req, "read");
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const site = await getRuntimeSiteConfig();
  if (!site.explore.enabled) {
    return NextResponse.json({ error: "explore is not enabled" }, { status: 404 });
  }

  const cursor = parseCursor(req.nextUrl.searchParams.get("cursor"));

  const where: Record<string, unknown> = {
    source: "fedi",
    isOutgoing: false,
    // A row the OWNER pulled in by expanding a thread is not discovery — they
    // already saw it, and they didn't ask for it to become a feed.
    viaLookup: false,
  };
  if (cursor) Object.assign(where, cursorWhere(cursor));

  // Nested under AND because `cursorWhere` already contributes a top-level OR
  // and Prisma would let the second one overwrite the first — silently, and only
  // from page two onwards, which is the worst way to find out.
  //
  // The boostedBy leg is not redundant with discoveredVia. Boost rows written
  // before this column existed carry NULL, and they are the whole of Tier 0:
  // content that has been arriving and being discarded since boosts were
  // implemented. Dropping the leg would make Explore look empty on every
  // instance that upgrades until a new boost happens to arrive.
  Object.assign(where, {
    AND: [{ OR: [{ boostedBy: { not: null } }, { discoveredVia: { not: null } }] }],
  });

  Object.assign(where, await blockedPostFilter());

  const posts = await prisma.fediPost.findMany({
    where,
    orderBy: CURSOR_ORDER,
    take: PAGE_SIZE + 1,
  });

  const hasMore = posts.length > PAGE_SIZE;
  const page = hasMore ? posts.slice(0, PAGE_SIZE) : posts;

  // Who surfaced each one. A boost already carries it (`boostedByName`); a
  // reply-parent doesn't, because the row is the STRANGER's post — the person
  // the owner follows is whoever replied to it.
  //
  // Derived per page rather than stored on the row: it is a fact about the
  // follow graph, which changes, and one extra query for a page of twenty beats
  // a column that goes stale the moment someone is unfollowed.
  const parentApIds = page
    .filter((p) => p.discoveredVia === VIA_REPLY_PARENT && p.apId)
    .map((p) => p.apId as string);
  const viaReply = new Map<string, string>();
  if (parentApIds.length > 0) {
    const followed = (await prisma.fediFollowing.findMany({ select: { actorUri: true } }))
      .map((f) => f.actorUri);
    const repliers = await prisma.fediPost.findMany({
      where: { inReplyTo: { in: parentApIds }, actorUri: { in: followed }, isOutgoing: false },
      select: { inReplyTo: true, displayName: true, username: true, domain: true },
      orderBy: { publishedAt: "desc" },
    });
    for (const r of repliers) {
      if (!r.inReplyTo || viaReply.has(r.inReplyTo)) continue;
      viaReply.set(r.inReplyTo, r.displayName || `@${r.username}@${r.domain}`);
    }
  }

  // Re-sanitized on every emit, as the feed route does — protects rows stored
  // before sanitization was tightened.
  const safePage = page.map((p) => ({
    ...p,
    contentHtml: p.contentHtml ? sanitizeHtml(p.contentHtml) : null,
    /** "boosted" or "replied" — how this reached the owner, for the card label. */
    discoveredBy: p.boostedBy
      ? { how: "boosted" as const, who: p.boostedByName }
      : p.apId && viaReply.has(p.apId)
        ? { how: "replied" as const, who: viaReply.get(p.apId) as string }
        : null,
  }));

  const last = page[page.length - 1];
  const nextCursor = hasMore ? encodeCursor(last.publishedAt, last.id) : null;

  return NextResponse.json({
    posts: JSON.parse(JSON.stringify(safePage)),
    nextCursor,
  });
}
