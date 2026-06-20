import { NextRequest, NextResponse } from "next/server";
import { verifyMicropubToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sanitizeHtml } from "@/lib/sanitize";
import { marked } from "marked";
import { buildPostObject } from "@/lib/ap-post";

const DEBUG = process.env.FEDIHOME_DEBUG === "true";

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

  const contentType = req.headers.get("content-type") || "";

  let properties: Record<string, string[]>;

  if (contentType.includes("application/json")) {
    const body = await req.json();
    properties = body.properties || {};

    // Handle delete
    if (body.action === "delete" && body.url) {
      const slug = body.url.split("/").pop();
      await prisma.post.delete({ where: { slug: slug || "" } }).catch(() => {});
      return new NextResponse(null, { status: 204 });
    }
  } else {
    // Form-encoded
    const form = await req.formData();
    properties = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        properties[key] = properties[key] || [];
        properties[key].push(value);
      }
    }
    // Normalize h-entry properties
    if (properties.h) delete properties.h;
  }

  const title = properties.name?.[0] || null;
  const content = properties.content?.[0] || "";
  const category = properties["post-status"]?.[0] === "draft"
    ? "note"
    : properties.category?.[0] || (title ? "article" : "note");
  const tags = properties.category || [];
  const photos = properties.photo || [];

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
      category,
      tags,
      photos,
      published: properties["post-status"]?.[0] !== "draft",
      apId: `${siteUrl}/post/${slug}`,
    },
  });

  // Federate the post via ActivityPub
  if (post.published) {
    const { deliverToFollowers } = await import("@/lib/http-signatures");
    const activity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${siteUrl}/ap/create/${post.id}`,
      type: "Create",
      actor: `${siteUrl}/ap/actor`,
      published: post.publishedAt.toISOString(),
      object: buildPostObject(post),
    };
    deliverToFollowers(activity).catch((err) =>
      console.error("Failed to federate post:", err)
    );

    // Cross-post to Bluesky + Threads
    const { crosspostToBluesky, crosspostToThreads } = await import("@/lib/crosspost");
    const postUrl = `${siteUrl}/post/${slug}`;
    crosspostToBluesky(content, postUrl).then((r) => {
      if (DEBUG && r.success) console.log("Cross-posted to Bluesky:", r.uri);
      else console.error("Bluesky crosspost failed:", r.error);
    });
    crosspostToThreads(content, postUrl).then((r) => {
      if (DEBUG && r.success) console.log("Cross-posted to Threads:", r.id);
      else console.error("Threads crosspost failed:", r.error);
    });
  }

  return new NextResponse(null, {
    status: 201,
    headers: { Location: `${siteUrl}/post/${post.slug}` },
  });
}
