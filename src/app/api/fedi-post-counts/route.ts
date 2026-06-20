import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { assertPublicHost } from "@/lib/url-guard";
import { signedGet } from "@/lib/http-signatures";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 8000;

interface Counts {
  likeCount: number | null;
  boostCount: number | null;
  replyCount: number | null;
}
interface CountsResult extends Counts {
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

  // Boosts use a synthetic "boost:<actor>:<originalApId>" id — count the original.
  const sourceApId = post.apId.startsWith("boost:")
    ? post.apId.match(/^boost:.*:(https?:\/\/.*)$/)?.[1] || post.apId
    : post.apId;

  if (!(await assertPublicHost(sourceApId))) {
    return NextResponse.json({ error: "blocked host" }, { status: 400 });
  }

  // 1) Mastodon-API servers (Mastodon, Pixelfed, GoToSocial, Pleroma/Akkoma)
  //    expose all three counts publicly via REST — the most reliable source.
  // 2) Otherwise read the signed ActivityPub object's collection totals.
  let counts =
    (await fetchCountsViaMastodonApi(sourceApId)) ||
    (await fetchCountsViaAp(sourceApId)) ||
    { likeCount: null, boostCount: null, replyCount: null };

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
 * Read counts from the Mastodon REST API (`/api/v1/statuses/:id`). Public posts
 * expose favourites/reblogs/replies counts without auth. The status id is the
 * last path segment of the canonical URL. Returns null if it's not a
 * Mastodon-API server / status (so the AP fallback can run).
 */
async function fetchCountsViaMastodonApi(apId: string): Promise<Counts | null> {
  let u: URL;
  try {
    u = new URL(apId);
  } catch {
    return null;
  }
  const id = u.pathname.split("/").filter(Boolean).pop();
  if (!id) return null;
  const apiUrl = `${u.origin}/api/v1/statuses/${encodeURIComponent(id)}`;
  if (!(await assertPublicHost(apiUrl))) return null;
  try {
    const res = await fetch(apiUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const s = (await res.json()) as {
      favourites_count?: unknown;
      reblogs_count?: unknown;
      replies_count?: unknown;
    };
    const fav = typeof s.favourites_count === "number" ? s.favourites_count : null;
    const reb = typeof s.reblogs_count === "number" ? s.reblogs_count : null;
    const rep = typeof s.replies_count === "number" ? s.replies_count : null;
    // Only treat it as a real status object if at least one count is present.
    if (fav === null && reb === null && rep === null) return null;
    return { likeCount: fav, boostCount: reb, replyCount: rep };
  } catch {
    return null;
  }
}

/** Read collection totals from the signed ActivityPub object. */
async function fetchCountsViaAp(apId: string): Promise<Counts | null> {
  try {
    const res = await signedGet(apId, FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const note = await res.json();
    return {
      likeCount: await readTotalItems(note.likes),
      boostCount: await readTotalItems(note.shares),
      replyCount: await readTotalItems(note.replies),
    };
  } catch {
    return null;
  }
}

/**
 * AP collection fields (`likes`, `shares`, `replies`) are either an inline
 * OrderedCollection or a URL to one. Returns null if the remote hides the
 * collection or anything fails.
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
    const res = await signedGet(field, FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const collection = (await res.json()) as { totalItems?: unknown };
    return typeof collection.totalItems === "number" ? collection.totalItems : null;
  } catch {
    return null;
  }
}
