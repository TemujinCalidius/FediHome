import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";

export async function GET() {
  const posts = await prisma.post.findMany({
    where: { published: true, apId: { not: null } },
    orderBy: { publishedAt: "desc" },
    take: 50,
    include: { inReplyTo: { select: { apId: true } } },
  });

  const items = posts.map((post) => {
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      webp: "image/webp", gif: "image/gif",
    };
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

    return {
      type: "Create",
      actor: `${siteUrl}/ap/actor`,
      published: post.publishedAt.toISOString(),
      object: {
        type: post.title ? "Article" : "Note",
        id: post.apId,
        attributedTo: `${siteUrl}/ap/actor`,
        ...(post.title ? { name: post.title } : {}),
        content: post.contentHtml || post.content,
        published: post.publishedAt.toISOString(),
        url: `${siteUrl}/post/${post.slug}`,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [`${siteUrl}/ap/followers`],
        ...(post.inReplyTo?.apId ? { inReplyTo: post.inReplyTo.apId } : {}),
        ...(attachment.length > 0 ? { attachment } : {}),
        ...(tags.length > 0 ? { tag: tags } : {}),
      },
    };
  });

  return NextResponse.json(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${siteUrl}/ap/outbox`,
      type: "OrderedCollection",
      totalItems: items.length,
      orderedItems: items,
    },
    {
      headers: { "Content-Type": "application/activity+json; charset=utf-8" },
    }
  );
}
