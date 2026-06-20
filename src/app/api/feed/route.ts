import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin } from "@/lib/auth";
import { sanitizeHtml } from "@/lib/sanitize";

const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  // Admin-only
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cursor = req.nextUrl.searchParams.get("cursor"); // publishedAt ISO string
  const showReplies = req.nextUrl.searchParams.get("replies") === "1";
  const showBoosts = req.nextUrl.searchParams.get("boosts") === "1";

  const where: Record<string, unknown> = {};
  if (cursor) {
    where.publishedAt = { lt: new Date(cursor) };
  }
  if (!showReplies) {
    where.inReplyTo = null;
  }
  if (!showBoosts) {
    where.boostedBy = null;
  }

  const posts = await prisma.fediPost.findMany({
    where,
    orderBy: { publishedAt: "desc" },
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
  const nextCursor = hasMore ? page[page.length - 1].publishedAt.toISOString() : null;

  return NextResponse.json({
    posts: JSON.parse(JSON.stringify(safePage)),
    nextCursor,
  });
}
