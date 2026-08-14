import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { blockedPostFilter } from "@/lib/blocks";
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

  // Attach parent summary for each reply so the list reads naturally without a
  // second round trip. A parent shows as null when it isn't cached locally, and
  // now also when its author is blocked (#559) — the UI renders the same
  // fallback line for both, which is deliberate: a distinct message would tell
  // the owner a row exists that is being withheld.
  const parentApIds = Array.from(
    new Set(page.map((p) => p.inReplyTo).filter((v): v is string => Boolean(v)))
  );
  const parents = parentApIds.length
    ? await prisma.fediPost.findMany({
        // The replies above are OUR OWN (isOutgoing), which is why they need no
        // filter — but their PARENTS are other people's posts, and one of them
        // can be someone the owner has blocked (#559). Without this the list
        // rendered a blocked account's name, avatar and a snippet of their post.
        //
        // A filter rather than a post-check because the right outcome here is
        // simply absence: a parent that isn't cached is already null, and the UI
        // has rendered that state since this endpoint existed.
        where: { apId: { in: parentApIds }, ...(await blockedPostFilter()) },
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
