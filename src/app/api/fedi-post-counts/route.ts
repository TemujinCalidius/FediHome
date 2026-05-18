import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { assertPublicHost } from "@/lib/url-guard";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 8000;

interface CountsResult {
  likeCount: number | null;
  boostCount: number | null;
  replyCount: number | null;
  countsFetchedAt: string;
}

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const postId = body?.postId as string | undefined;
  if (!postId) {
    return NextResponse.json({ error: "postId required" }, { status: 400 });
  }

  const post = await prisma.fediPost.findUnique({ where: { id: postId } });
  if (!post) {
    return NextResponse.json({ error: "post not found" }, { status: 404 });
  }

  // Serve from cache if fresh
  if (
    post.countsFetchedAt &&
    Date.now() - post.countsFetchedAt.getTime() < CACHE_TTL_MS
  ) {
    return NextResponse.json({
      likeCount: post.likeCount,
      boostCount: post.boostCount,
      replyCount: post.replyCount,
      countsFetchedAt: post.countsFetchedAt.toISOString(),
    } satisfies CountsResult);
  }

  if (!(await assertPublicHost(post.apId))) {
    return NextResponse.json({ error: "blocked host" }, { status: 400 });
  }

  let counts: { likeCount: number | null; boostCount: number | null; replyCount: number | null };
  try {
    const noteRes = await fetch(post.apId, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!noteRes.ok) {
      counts = { likeCount: null, boostCount: null, replyCount: null };
    } else {
      const note = await noteRes.json();
      counts = {
        likeCount: await readTotalItems(note.likes),
        boostCount: await readTotalItems(note.shares),
        replyCount: await readTotalItems(note.replies),
      };
    }
  } catch {
    counts = { likeCount: null, boostCount: null, replyCount: null };
  }

  const updated = await prisma.fediPost.update({
    where: { id: postId },
    data: { ...counts, countsFetchedAt: new Date() },
    select: { likeCount: true, boostCount: true, replyCount: true, countsFetchedAt: true },
  });

  return NextResponse.json({
    likeCount: updated.likeCount,
    boostCount: updated.boostCount,
    replyCount: updated.replyCount,
    countsFetchedAt: updated.countsFetchedAt!.toISOString(),
  } satisfies CountsResult);
}

/**
 * AP collection fields (`likes`, `shares`, `replies`) are either an inline
 * OrderedCollection or a URL to one. Returns null if the remote hides the
 * collection (Mastodon authenticated-fetch) or anything fails.
 */
async function readTotalItems(field: unknown): Promise<number | null> {
  if (field == null) return null;
  if (typeof field === "object") {
    const obj = field as { totalItems?: unknown };
    if (typeof obj.totalItems === "number") return obj.totalItems;
    return null;
  }
  if (typeof field !== "string") return null;
  if (!(await assertPublicHost(field))) return null;
  try {
    const res = await fetch(field, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const collection = (await res.json()) as { totalItems?: unknown };
    return typeof collection.totalItems === "number" ? collection.totalItems : null;
  } catch {
    return null;
  }
}
