import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin } from "@/lib/auth";
import { htmlToText } from "@/lib/html-text";

const PAGE_SIZE = 25;

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cursor = req.nextUrl.searchParams.get("cursor"); // publishedAt ISO string

  const where: Record<string, unknown> = {
    isOutgoing: true,
    inReplyTo: { not: null },
  };
  if (cursor) {
    where.publishedAt = { lt: new Date(cursor) };
  }

  const replies = await prisma.fediPost.findMany({
    where,
    orderBy: { publishedAt: "desc" },
    take: PAGE_SIZE + 1,
  });

  const hasMore = replies.length > PAGE_SIZE;
  const page = hasMore ? replies.slice(0, PAGE_SIZE) : replies;
  const nextCursor = hasMore ? page[page.length - 1].publishedAt.toISOString() : null;

  // Attach parent summary for each reply so the list reads naturally without
  // a second round trip. Parents not cached locally show as null and the UI
  // falls back to a generic "another post" label.
  const parentApIds = Array.from(
    new Set(page.map((p) => p.inReplyTo).filter((v): v is string => Boolean(v)))
  );
  const parents = parentApIds.length
    ? await prisma.fediPost.findMany({
        where: { apId: { in: parentApIds } },
        select: {
          apId: true,
          username: true,
          domain: true,
          displayName: true,
          avatarUrl: true,
          content: true,
          publishedAt: true,
        },
      })
    : [];
  const parentByApId = new Map(parents.map((p) => [p.apId, p]));

  const items = page.map((r) => {
    const parent = r.inReplyTo ? parentByApId.get(r.inReplyTo) ?? null : null;
    return {
      ...r,
      publishedAt: r.publishedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      countsFetchedAt: r.countsFetchedAt ? r.countsFetchedAt.toISOString() : null,
      parent: parent
        ? {
            apId: parent.apId,
            username: parent.username,
            domain: parent.domain,
            displayName: parent.displayName,
            avatarUrl: parent.avatarUrl,
            snippet: htmlToText(parent.content, 160),
            publishedAt: parent.publishedAt.toISOString(),
          }
        : null,
    };
  });

  return NextResponse.json({ replies: items, nextCursor });
}
