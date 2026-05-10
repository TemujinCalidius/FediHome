import { prisma } from "@/lib/db";
import { siteConfig } from "@/../site.config";

export async function GET() {
  const siteUrl = siteConfig.url;

  const posts = await prisma.post.findMany({
    where: { published: true, inReplyToPostId: null },
    orderBy: { publishedAt: "desc" },
    take: 50,
  });

  const escapeXml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const items = posts
    .map(
      (post) => `
    <item>
      <title>${escapeXml(post.title || post.content.slice(0, 80))}</title>
      <link>${siteUrl}/post/${post.slug}</link>
      <guid isPermaLink="true">${siteUrl}/post/${post.slug}</guid>
      <pubDate>${post.publishedAt.toUTCString()}</pubDate>
      <description>${escapeXml(post.excerpt || post.content.slice(0, 280))}</description>
      <category>${post.category}</category>
    </item>`
    )
    .join("\n");

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteConfig.authorName)}</title>
    <link>${siteUrl}</link>
    <description>${escapeXml(siteConfig.description)}</description>
    <language>en-au</language>
    <atom:link href="${siteUrl}/feed.xml" rel="self" type="application/rss+xml" />
    ${items}
  </channel>
</rss>`;

  return new Response(feed, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
