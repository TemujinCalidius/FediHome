import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";
import { htmlToText } from "@/lib/html-text";
import { rateLimitKey } from "@/lib/client-ip";
import { makeRateLimiter } from "@/lib/oauth";

/**
 * Search the owner's own published content — posts and photos. Read-scoped
 * (owner cookie OR a `read` bearer token, so the native app can use it). GET is
 * read-only → no CSRF. Only ever returns **published** rows (never drafts).
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_QUERY = 2;
const SNIPPET_LEN = 200;
const searchLimiter = makeRateLimiter(30, 60_000);

interface SearchResult {
  type: "post" | "photo";
  slug: string;
  title: string;
  snippet: string;
  category: string;
  url: string;
  publishedAt: string;
}

export async function GET(req: NextRequest) {
  if (!(await authenticateApiRequest(req, "read")).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!searchLimiter.check(rateLimitKey(req), Date.now())) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  const type = req.nextUrl.searchParams.get("type") || "all"; // all | post | photo
  const limitRaw = Number(req.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : DEFAULT_LIMIT;

  if (q.length < MIN_QUERY) {
    return NextResponse.json({ query: q, count: 0, results: [] });
  }

  const wantPosts = type === "all" || type === "post";
  const wantPhotos = type === "all" || type === "photo";
  const ci = { contains: q, mode: "insensitive" as const };

  const [posts, photos] = await Promise.all([
    wantPosts
      ? prisma.post.findMany({
          where: {
            published: true, // never surface drafts
            OR: [{ title: ci }, { content: ci }, { excerpt: ci }, { tags: { has: q } }],
          },
          orderBy: { publishedAt: "desc" },
          take: limit,
          select: {
            slug: true, title: true, content: true, contentHtml: true,
            excerpt: true, category: true, publishedAt: true,
          },
        })
      : Promise.resolve([]),
    wantPhotos
      ? prisma.photo.findMany({
          where: {
            published: true, // never surface drafts
            OR: [{ title: ci }, { caption: ci }, { tags: { has: q } }],
          },
          orderBy: { publishedAt: "desc" },
          take: limit,
          select: { slug: true, title: true, caption: true, category: true, publishedAt: true },
        })
      : Promise.resolve([]),
  ]);

  const postResults: SearchResult[] = posts.map((p) => ({
    type: "post",
    slug: p.slug,
    title: p.title || p.slug,
    snippet: (p.excerpt?.trim() || htmlToText(p.contentHtml || p.content || "", SNIPPET_LEN)).trim(),
    category: p.category,
    url: `/post/${p.slug}`,
    publishedAt: p.publishedAt.toISOString(),
  }));

  const photoResults: SearchResult[] = photos.map((ph) => ({
    type: "photo",
    slug: ph.slug,
    title: ph.title || ph.slug,
    snippet: (ph.caption || "").trim(),
    category: ph.category,
    url: `/photography/${ph.slug}`,
    publishedAt: ph.publishedAt.toISOString(),
  }));

  const results = [...postResults, ...photoResults]
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
    .slice(0, limit);

  return NextResponse.json({ query: q, count: results.length, results });
}
