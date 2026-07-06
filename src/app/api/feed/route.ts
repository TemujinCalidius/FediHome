import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";
import { sanitizeHtml } from "@/lib/sanitize";
import { parseCursor, cursorWhere, encodeCursor, CURSOR_ORDER } from "@/lib/cursor";

const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  // Owner cookie OR a `read`-scoped bearer token (a native app). Read-only → no CSRF.
  if (!(await authenticateApiRequest(req, "read")).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cursor = parseCursor(req.nextUrl.searchParams.get("cursor")); // "<iso>_<id>"
  const showReplies = req.nextUrl.searchParams.get("replies") === "1";
  const showBoosts = req.nextUrl.searchParams.get("boosts") === "1";

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
