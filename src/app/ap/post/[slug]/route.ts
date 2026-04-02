import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";

const mimeMap: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const post = await prisma.post.findUnique({ where: { slug } });
  if (!post || !post.published || !post.apId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const attachment = post.photos.map((url) => {
    const ext = url.split(".").pop()?.toLowerCase() || "jpg";
    return {
      type: "Image",
      mediaType: mimeMap[ext] || "image/jpeg",
      url: url.startsWith("http") ? url : `${siteUrl}${url}`,
      name: "",
    };
  });

  const tags = (post.tags || []).map((tag) => ({
    type: "Hashtag",
    href: `https://mastodon.social/tags/${tag}`,
    name: `#${tag}`,
  }));

  const object = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    type: post.title ? "Article" : "Note",
    id: post.apId,
    attributedTo: `${siteUrl}/ap/actor`,
    ...(post.title ? { name: post.title } : {}),
    content: post.contentHtml || `<p>${post.content.replace(/\n/g, "<br>")}</p>`,
    url: `${siteUrl}/post/${post.slug}`,
    published: post.publishedAt.toISOString(),
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${siteUrl}/ap/followers`],
    ...(attachment.length > 0 ? { attachment } : {}),
    ...(tags.length > 0 ? { tag: tags } : {}),
  };

  return NextResponse.json(object, {
    headers: {
      "Content-Type": "application/activity+json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
