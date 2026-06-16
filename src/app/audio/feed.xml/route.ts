import { prisma } from "@/lib/db";
import { siteConfig } from "@/../site.config";

export const dynamic = "force-dynamic";

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function formatDuration(sec: number | null): string {
  if (!sec || sec < 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export async function GET() {
  const siteUrl = process.env.SITE_URL || "http://localhost:3000";
  const podcastTitle =
    process.env.PODCAST_TITLE || `${siteConfig.authorName} — Audio`;
  const podcastAuthor = process.env.PODCAST_AUTHOR || siteConfig.authorName;
  const podcastDescription = process.env.PODCAST_DESCRIPTION || "Audio recordings and field notes.";
  const podcastEmail = process.env.PODCAST_EMAIL || process.env.CONTACT_EMAIL || "noreply@example.com";
  const podcastImage = process.env.PODCAST_IMAGE || `${siteUrl}/icon.png`;

  const audios = await prisma.audio.findMany({
    where: { published: true },
    orderBy: { publishedAt: "desc" },
    take: 100,
  });

  const items = audios.map((a) => {
    const link = `${siteUrl}/audio/${a.slug}`;
    const enclosureUrl = a.mp3Path.startsWith("http") ? a.mp3Path : `${siteUrl}${a.mp3Path}`;
    const length = a.fileSize ?? 0;
    const desc = a.description || a.title || a.slug;
    return `    <item>
      <title>${escapeXml(a.title || a.slug)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${a.publishedAt.toUTCString()}</pubDate>
      <description>${escapeXml(desc)}</description>
      <enclosure url="${escapeXml(enclosureUrl)}" length="${length}" type="audio/mpeg" />
      <itunes:duration>${formatDuration(a.durationSec)}</itunes:duration>
${a.coverImage ? `      <itunes:image href="${escapeXml(a.coverImage.startsWith("http") ? a.coverImage : `${siteUrl}${a.coverImage}`)}" />` : ""}
    </item>`;
  }).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(podcastTitle)}</title>
    <link>${escapeXml(siteUrl)}/audio</link>
    <atom:link href="${escapeXml(siteUrl)}/audio/feed.xml" rel="self" type="application/rss+xml" />
    <language>en</language>
    <description>${escapeXml(podcastDescription)}</description>
    <itunes:author>${escapeXml(podcastAuthor)}</itunes:author>
    <itunes:summary>${escapeXml(podcastDescription)}</itunes:summary>
    <itunes:owner>
      <itunes:name>${escapeXml(podcastAuthor)}</itunes:name>
      <itunes:email>${escapeXml(podcastEmail)}</itunes:email>
    </itunes:owner>
    <itunes:image href="${escapeXml(podcastImage)}" />
    <itunes:category text="Arts" />
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
