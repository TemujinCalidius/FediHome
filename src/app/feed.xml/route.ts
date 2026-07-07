import { prisma } from "@/lib/db";
import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "@/lib/site-profile";
import { getRuntimeSiteConfig } from "@/lib/site-settings";

export async function GET() {
  const siteUrl = siteConfig.url;
  const profile = await getRuntimeProfile();
  const site = await getRuntimeSiteConfig();

  const posts = await prisma.post.findMany({
    where: { published: true, inReplyToPostId: null },
    orderBy: { publishedAt: "desc" },
    take: 50,
  });

  // XML-escape for element text / attribute values OUTSIDE CDATA.
  const xml = (s: string) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  // Wrap raw HTML so it survives as a single CDATA section.
  const cdata = (s: string) => `<![CDATA[${String(s).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
  // Make a (possibly relative) media path absolute — RSS readers need full URLs.
  const abs = (u: string) =>
    !u ? "" : /^https?:\/\//.test(u) ? u : `${siteUrl}${u.startsWith("/") ? "" : "/"}${u}`;
  // Escape text destined for inside the HTML body (it lives in CDATA).
  const htmlText = (s: string) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const htmlAttr = (s: string) => htmlText(s).replace(/"/g, "&quot;");
  const mime = (u: string) => {
    const e = (u.split("?")[0].split(".").pop() || "").toLowerCase();
    return e === "png" ? "image/png" : e === "webp" ? "image/webp" : e === "gif" ? "image/gif" : "image/jpeg";
  };

  const items = posts
    .map((post) => {
      // Titleless notes get a date+time headline instead of repeating their body.
      const title =
        post.title ||
        post.publishedAt.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });

      // Body: the rendered HTML (fall back to paragraph-wrapped plain content)...
      let html =
        post.contentHtml ||
        (post.content
          ? `<p>${htmlText(post.content).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`
          : "");

      // ...then attach media so photos/videos/audio show in the reader.
      const photos = post.photos || [];
      const images = photos.length ? photos : post.coverImage ? [post.coverImage] : [];
      images.forEach((src, i) => {
        const cap = photos.length ? post.photoCaptions?.[i] || "" : "";
        html += `<p><img src="${htmlAttr(abs(src))}" alt="${htmlAttr(cap)}" style="max-width:100%;height:auto" />${
          cap ? `<br><em>${htmlText(cap)}</em>` : ""
        }</p>`;
      });
      (post.videos || []).forEach((v, i) => {
        const t = post.videoTitles?.[i] || "Watch video";
        const thumb = post.videoThumbnails?.[i];
        html += `<p>${
          thumb ? `<a href="${htmlAttr(v)}"><img src="${htmlAttr(abs(thumb))}" alt="${htmlAttr(t)}" style="max-width:100%;height:auto" /></a><br>` : ""
        }<a href="${htmlAttr(v)}">▶ ${htmlText(t)}</a></p>`;
      });
      (post.audioPaths || []).forEach((a, i) => {
        const t = post.audioTitles?.[i] || "Listen";
        html += `<p>🎧 <a href="${htmlAttr(abs(a))}">${htmlText(t)}</a></p>`;
      });

      // A lead image as an enclosure for thumbnail-style readers.
      const lead = post.coverImage || photos[0] || (post.videoThumbnails || []).find(Boolean) || "";
      const enclosure = lead
        ? `\n      <enclosure url="${xml(abs(lead))}" type="${mime(lead)}" length="0" />`
        : "";

      return `
    <item>
      <title>${xml(title)}</title>
      <link>${siteUrl}/post/${post.slug}</link>
      <guid isPermaLink="true">${siteUrl}/post/${post.slug}</guid>
      <pubDate>${post.publishedAt.toUTCString()}</pubDate>
      <description>${cdata(html)}</description>${enclosure}
      <category>${xml(post.category)}</category>
    </item>`;
    })
    .join("\n");

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(profile.authorName)}</title>
    <link>${siteUrl}</link>
    <description>${xml(site.description)}</description>
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
