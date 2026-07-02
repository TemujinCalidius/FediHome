import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";

/**
 * List the owner's OWN posts — the backing data for a native "My Posts" content
 * manager (#182). Read-scoped (owner cookie OR a `read` bearer). GET → no CSRF.
 * Unlike `/api/feed` (the incoming timeline) this returns the owner's content,
 * including drafts, so it can be reviewed/edited/deleted (via Micropub).
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function GET(req: NextRequest) {
  if (!(await authenticateApiRequest(req, "read")).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const cursor = sp.get("cursor"); // publishedAt ISO
  const status = sp.get("status") || "all"; // all | published | draft | scheduled
  const type = sp.get("type"); // note | article | journal | photo | video | audio
  const limitRaw = Number(sp.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : DEFAULT_LIMIT;

  const where: Record<string, unknown> = {};
  if (cursor) where.publishedAt = { lt: new Date(cursor) };
  if (status === "published") where.published = true;
  else if (status === "scheduled") { where.published = false; where.scheduledFor = { not: null }; }
  else if (status === "draft") { where.published = false; where.scheduledFor = null; }
  if (type === "photo") where.photos = { isEmpty: false };
  else if (type === "video") where.videos = { isEmpty: false };
  else if (type === "audio") where.audioPaths = { isEmpty: false };
  else if (type === "note" || type === "article" || type === "journal") where.category = type;

  const rows = await prisma.post.findMany({
    where,
    orderBy: { publishedAt: "desc" },
    take: limit + 1,
    select: {
      slug: true, title: true, excerpt: true, category: true,
      photos: true, videos: true, audioPaths: true,
      published: true, publishedAt: true, updatedAt: true, scheduledFor: true,
      likeCount: true, boostCount: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const posts = page.map((p) => {
    const photos = p.photos.length;
    const videos = p.videos.length;
    const audio = p.audioPaths.length;
    // Derived kind for the app: media takes precedence, else the text category.
    const kind = photos ? "photo" : videos ? "video" : audio ? "audio" : p.category;
    const status = p.published ? "published" : p.scheduledFor ? "scheduled" : "draft";
    return {
      slug: p.slug,
      url: `/post/${p.slug}`,
      title: p.title,
      excerpt: p.excerpt,
      category: p.category,
      type: kind,
      status,
      published: p.published,
      publishedAt: p.publishedAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      scheduledFor: p.scheduledFor ? p.scheduledFor.toISOString() : null,
      counts: { likes: p.likeCount, boosts: p.boostCount },
      media: { photos, videos, audio },
    };
  });

  const nextCursor = hasMore ? page[page.length - 1].publishedAt.toISOString() : null;
  return NextResponse.json({ posts, nextCursor });
}
