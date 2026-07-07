import { NextRequest, NextResponse } from "next/server";
import { verifyMicropubToken, hasScope } from "@/lib/auth";
import { recordTokenUse } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { sanitizeHtml } from "@/lib/sanitize";
import { marked } from "marked";
import { publishPost } from "@/lib/publish-post";
import { deletePostWithFederation } from "@/lib/delete-post";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function generateSlug(title: string | null, content: string): string {
  if (title) return slugify(title);
  // For untitled posts, use first few words + timestamp
  const words = content.replace(/[#@]/g, "").trim().split(/\s+/).slice(0, 5).join("-");
  const ts = Date.now().toString(36);
  return slugify(`${words}-${ts}`);
}

export async function GET(req: NextRequest) {
  // Micropub query — used by clients to discover config
  const q = req.nextUrl.searchParams.get("q");

  if (q === "config") {
    return NextResponse.json({
      "media-endpoint": `${process.env.SITE_URL || "http://localhost:3000"}/api/media`,
      "post-types": [
        { type: "note", name: "Note" },
        { type: "article", name: "Article" },
        { type: "photo", name: "Photo" },
      ],
      categories: ["journal", "note", "article", "photo"],
    });
  }

  if (q === "source") {
    // Owner-only: q=source returns a post's full source, INCLUDING unpublished
    // drafts and scheduled posts. Without this gate any unauthenticated caller
    // could read draft content by (guessable) slug. Single-owner instance, so a
    // valid token is the owner; matches the POST handler's auth.
    const auth = await verifyMicropubToken(req.headers.get("authorization"));
    if (!auth.valid) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const url = req.nextUrl.searchParams.get("url");
    if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });
    const slug = url.split("/").pop();
    const post = await prisma.post.findUnique({ where: { slug: slug || "" } });
    if (!post) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({
      type: ["h-entry"],
      properties: {
        name: post.title ? [post.title] : [],
        content: [post.content],
        summary: post.excerpt ? [post.excerpt] : [],
        published: [post.publishedAt.toISOString()],
        category: post.tags,
        "post-status": [post.published ? "published" : "draft"],
      },
    });
  }

  return NextResponse.json({ error: "invalid query" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  // Verify auth token
  const auth = await verifyMicropubToken(req.headers.get("authorization"));
  if (!auth.valid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Micropub is always a write (create/update/delete) — audit it. Best-effort.
  void recordTokenUse(auth, req);

  const contentType = req.headers.get("content-type") || "";

  let properties: Record<string, string[]> = {};
  let action: string | undefined;
  let url: string | undefined;

  if (contentType.includes("application/json")) {
    const body = await req.json();
    properties = body.properties || {};
    action = body.action;
    url = body.url;
  } else {
    // Form-encoded
    const form = await req.formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        properties[key] = properties[key] || [];
        properties[key].push(value);
      }
    }
    // Normalize h-entry properties
    if (properties.h) delete properties.h;
    action = properties.action?.[0];
    url = properties.url?.[0];
  }

  // Handle delete (Micropub §7.3) — form-encoded or JSON. Requires the `delete`
  // scope; federates the removal + cleans up child rows (via the shared helper).
  if (action === "delete") {
    if (!hasScope(auth.scope, "delete")) {
      return NextResponse.json({ error: "insufficient_scope", scope: "delete" }, { status: 403 });
    }
    if (!url) {
      return NextResponse.json({ error: "url required" }, { status: 400 });
    }
    const slug = url.split("/").filter(Boolean).pop();
    const post = await prisma.post.findUnique({ where: { slug: slug || "" } });
    if (!post) return NextResponse.json({ error: "not found" }, { status: 404 });
    await deletePostWithFederation(post);
    return new NextResponse(null, { status: 204 });
  }

  const title = properties.name?.[0] || null;
  const content = properties.content?.[0] || "";
  const category = properties["post-status"]?.[0] === "draft"
    ? "note"
    : properties.category?.[0] || (title ? "article" : "note");
  const tags = properties.category || [];
  const photos = properties.photo || [];
  // Micropub `summary` is the standard field for an article excerpt/description.
  const excerpt = properties.summary?.[0] || null;

  // Schedule for later: a future `mp-scheduled` (or `published`) datetime creates
  // the post unpublished; the scheduler federates it at that time. (#183)
  const scheduledRaw = properties["mp-scheduled"]?.[0] || properties.published?.[0];
  const scheduledForDate = scheduledRaw ? new Date(scheduledRaw) : null;
  const isScheduled =
    !!scheduledForDate && !isNaN(scheduledForDate.getTime()) && scheduledForDate.getTime() > Date.now();

  if (!content && !photos.length) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }

  const slug = generateSlug(title, content);
  const siteUrl = process.env.SITE_URL || "http://localhost:3000";
  const contentHtml = sanitizeHtml(marked.parse(content) as string);

  const post = await prisma.post.create({
    data: {
      slug,
      title,
      content,
      contentHtml,
      excerpt,
      category,
      tags,
      photos,
      published: properties["post-status"]?.[0] !== "draft" && !isScheduled,
      ...(isScheduled ? { publishedAt: scheduledForDate!, scheduledFor: scheduledForDate! } : {}),
      apId: `${siteUrl}/post/${slug}`,
    },
  });

  // Federate + crosspost via the shared publisher (also used by the scheduler).
  // Fire-and-forget so the 201 isn't blocked on delivery.
  if (post.published) {
    void publishPost(post);
  }

  return new NextResponse(null, {
    status: 201,
    headers: { Location: `${siteUrl}/post/${post.slug}` },
  });
}
