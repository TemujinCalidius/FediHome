import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { deliverToFollowers } from "@/lib/http-signatures";
import { crosspostToBluesky, crosspostToThreads, crosspostToDayOne } from "@/lib/crosspost";
import { sanitizeHtml } from "@/lib/sanitize";
import path from "path";

const siteUrl = process.env.SITE_URL || "http://localhost:3000";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function extractHashtags(text: string): string[] {
  const matches = text.match(/#([a-zA-Z0-9_]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

function linkHashtags(text: string): string {
  return text.replace(
    /#([a-zA-Z0-9_]+)/g,
    '<a href="https://mastodon.social/tags/$1" class="hashtag" rel="tag">#$1</a>'
  );
}

function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "") // headers
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/__([^_]+)__/g, "$1") // bold
    .replace(/_([^_]+)_/g, "$1") // italic
    .replace(/~~([^~]+)~~/g, "$1") // strikethrough
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/```[\s\S]*?```/g, "") // code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "") // images
    .replace(/>\s+/g, "") // blockquotes
    .replace(/[-*+]\s+/g, "") // list items
    .replace(/\d+\.\s+/g, "") // numbered list items
    .replace(/\|[^|]*\|/g, "") // table rows
    .replace(/---+/g, "") // horizontal rules
    .trim();
}

/** Simple markdown to HTML — for article content rendered on site */
function renderMarkdown(md: string): string {
  let html = md;

  // Code blocks (before other processing)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const cls = lang ? ` class="language-${lang}"` : "";
    return `<pre><code${cls}>${code.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Bold and italic
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");

  // Strikethrough
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');

  // Blockquotes
  html = html.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");

  // Horizontal rules
  html = html.replace(/^---+$/gm, "<hr />");

  // Hashtags
  html = linkHashtags(html);

  // Paragraphs — wrap remaining text in <p> tags
  html = html
    .split(/\n\n+/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      // Don't wrap blocks that are already HTML block elements
      if (/^<(h[1-6]|pre|blockquote|ul|ol|table|hr|div)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return html;
}

export async function POST(req: NextRequest) {
  if (!verifyAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const {
    title,
    content,
    description,
    photos,
    crosspostBluesky,
    crosspostThreads,
    crosspostDayOne,
  } = body as {
    title?: string;
    content: string;
    description?: string;
    photos?: { url: string; alt: string }[];
    crosspostBluesky?: boolean;
    crosspostThreads?: boolean;
    crosspostDayOne?: boolean;
  };

  if (!content?.trim()) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  const isArticle = !!title?.trim();
  const category = isArticle ? "article" : "note";
  const tags = extractHashtags(content);
  const photoUrls = (photos || []).map((p) => p.url);
  const photoCaptions = (photos || []).map((p) => p.alt || "");

  // Generate slug
  const slugBase = title
    ? slugify(title)
    : slugify(content.slice(0, 40)) || `post-${Date.now().toString(36)}`;
  const slug = slugBase;

  // Render content HTML
  let contentHtml: string;
  if (isArticle) {
    contentHtml = sanitizeHtml(renderMarkdown(content));
  } else {
    // Note: plain text with hashtag links, auto-linked URLs, and line breaks
    const escaped = content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const withLinks = escaped.replace(
      /(https?:\/\/[^\s<&]+)/g,
      (url) => `<a href="${url}" rel="nofollow noopener noreferrer" target="_blank">${url}</a>`
    );
    contentHtml = `<p>${linkHashtags(withLinks).replace(/\n/g, "<br>")}</p>`;
  }

  // Create post
  const post = await prisma.post.create({
    data: {
      slug,
      title: isArticle ? title!.trim() : null,
      content,
      contentHtml,
      excerpt: description?.trim() || null,
      category,
      tags,
      photos: photoUrls,
      photoCaptions,
      published: true,
      apId: `${siteUrl}/post/${slug}`,
    },
  });

  // Build AP content for federation
  let apContent: string;
  if (isArticle) {
    // Article: send description + link, not full content
    const desc = description?.trim() || stripMarkdown(content).slice(0, 300);
    apContent = `<p>${desc.replace(/\n/g, "<br>")}</p>`;
  } else {
    apContent = contentHtml;
  }

  // Build AP attachment array for photos
  const apAttachments = (photos || []).map((p) => {
    const url = p.url.startsWith("http") ? p.url : `${siteUrl}${p.url}`;
    const ext = url.split(".").pop()?.toLowerCase() || "jpg";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      webp: "image/webp", gif: "image/gif",
    };
    return {
      type: "Image",
      mediaType: mimeMap[ext] || "image/jpeg",
      url,
      name: p.alt || "",
    };
  });

  // Build AP tag array for hashtags
  const apTags = tags.map((tag) => ({
    type: "Hashtag",
    href: `https://mastodon.social/tags/${tag}`,
    name: `#${tag}`,
  }));

  // Federation
  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteUrl}/ap/create/${post.id}`,
    type: "Create",
    actor: `${siteUrl}/ap/actor`,
    published: post.publishedAt.toISOString(),
    object: {
      type: isArticle ? "Article" : "Note",
      id: post.apId,
      attributedTo: `${siteUrl}/ap/actor`,
      ...(isArticle ? { name: title!.trim() } : {}),
      content: apContent,
      url: `${siteUrl}/post/${slug}`,
      published: post.publishedAt.toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${siteUrl}/ap/followers`],
      ...(apAttachments.length > 0 ? { attachment: apAttachments } : {}),
      ...(apTags.length > 0 ? { tag: apTags } : {}),
    },
  };

  deliverToFollowers(activity).catch((err) =>
    console.error("Failed to federate post:", err)
  );

  // Crossposting
  const postUrl = `${siteUrl}/post/${slug}`;
  const crosspostText = isArticle
    ? (description?.trim() || stripMarkdown(content).slice(0, 300))
    : content;

  if (crosspostBluesky !== false) {
    // Build image list with full URLs for Bluesky upload
    const bskyImages = (photos || []).map((p) => ({
      url: p.url.startsWith("http") ? p.url : `${siteUrl}${p.url}`,
      alt: p.alt || "",
    }));
    try {
      const bskyResult = await crosspostToBluesky(crosspostText, postUrl, bskyImages.length > 0 ? bskyImages : undefined);
      if (bskyResult.success && bskyResult.uri) {
        await prisma.post.update({
          where: { id: post.id },
          data: { blueskyUri: bskyResult.uri },
        });
      }
    } catch (err) {
      console.error("Bluesky crosspost failed:", err);
    }
  }

  if (crosspostThreads !== false) {
    crosspostToThreads(crosspostText, postUrl).catch((err) =>
      console.error("Threads crosspost failed:", err)
    );
  }

  if (crosspostDayOne !== false) {
    const dayOneImages = (photos || []).map((p) => {
      const url = p.url.startsWith("http") ? p.url : `${siteUrl}${p.url}`;
      const localPath = url.includes("/uploads/")
        ? path.join(process.cwd(), "public", new URL(url).pathname)
        : null;
      return { path: localPath, filename: url.split("/").pop() || "image.jpg" };
    }).filter((i) => i.path);

    crosspostToDayOne(content, postUrl, isArticle ? title!.trim() : undefined, dayOneImages).catch((err) =>
      console.error("DayOne crosspost failed:", err)
    );
  }

  return NextResponse.json({
    success: true,
    post: { id: post.id, slug: post.slug, url: postUrl },
  });
}
