import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest, verifyOrigin } from "@/lib/auth";
import { deliverActivity, deliverToFollowers } from "@/lib/http-signatures";
import { crosspostToBluesky, crosspostReplyToBluesky, crosspostToThreads, crosspostToDayOne } from "@/lib/crosspost";
import { sanitizeHtml } from "@/lib/sanitize";
import { parseMentions, linkMentions, buildApMentionTags, collectMentionInboxes } from "@/lib/mentions";
import { imageAttachment } from "@/lib/ap-post";
import { buildMediaUpdate } from "@/lib/post-media";
import { enqueueFailedCrosspost } from "@/lib/crosspost-retry";
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
  // Owner cookie OR a `create`-scoped bearer token, so a native app can use the
  // rich composer (photo galleries + captions, video, audio) that Micropub can't
  // express. The cookie path keeps CSRF; a bearer isn't ambient so it skips it.
  const auth = await authenticateApiRequest(req, "create");
  if (!auth.ok) {
    return auth.via === "bearer"
      ? NextResponse.json({ error: "insufficient_scope" }, { status: 403 })
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (auth.via === "cookie" && !verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    return await composeHandler(req);
  } catch (err) {
    console.error("Compose handler failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Compose failed" },
      { status: 500 }
    );
  }
}

async function composeHandler(req: NextRequest) {
  const body = await req.json();
  const {
    title,
    content,
    description,
    photos,
    videos,
    audios,
    crosspostBluesky,
    crosspostThreads,
    crosspostDayOne,
    addToPhotography,
    photoCategory,
    addToVideos,
    videoCategory,
    addToAudio,
    audioCategory,
    inReplyToPostId,
    editingPostId,
    scheduledFor,
  } = body as {
    title?: string;
    content: string;
    description?: string;
    photos?: { url: string; alt: string }[];
    videos?: {
      url: string;
      title: string;
      embedHost: string;
      embedId: string;
      iframeSrc: string;
      thumbnailUrl?: string | null;
      duration?: number | null;
    }[];
    audios?: {
      url: string;
      title: string;
      durationSec?: number | null;
      fileSize?: number | null;
      coverImage?: string | null;
    }[];
    crosspostBluesky?: boolean;
    crosspostThreads?: boolean;
    crosspostDayOne?: boolean;
    addToPhotography?: boolean;
    photoCategory?: string;
    addToVideos?: boolean;
    videoCategory?: string;
    addToAudio?: boolean;
    audioCategory?: string;
    inReplyToPostId?: string;
    editingPostId?: string;
    scheduledFor?: string; // future ISO datetime → schedule instead of publish now
  };

  if (!content?.trim()) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  // Edit branch: update existing post and federate AP Update
  if (editingPostId) {
    return await updatePostHandler(editingPostId, {
      title,
      content,
      description,
      photos,
      videos,
      audios,
    });
  }

  let parentPost: { id: string; apId: string | null; blueskyUri: string | null } | null = null;
  if (inReplyToPostId) {
    parentPost = await prisma.post.findUnique({
      where: { id: inReplyToPostId },
      select: { id: true, apId: true, blueskyUri: true },
    });
    if (!parentPost) {
      return NextResponse.json({ error: "Parent post not found" }, { status: 404 });
    }
  }

  const isArticle = !!title?.trim();
  const category = isArticle ? "article" : "note";
  const tags = extractHashtags(content);
  const photoUrls = (photos || []).map((p) => p.url);
  const photoCaptions = (photos || []).map((p) => p.alt || "");
  const videoUrls = (videos || []).map((v) => v.url);
  const videoTitles = (videos || []).map((v) => v.title || "");
  const videoThumbnails = (videos || []).map((v) => v.thumbnailUrl || "");
  const audioPaths = (audios || []).map((a) => a.url);
  const audioTitles = (audios || []).map((a) => a.title || "");
  const audioCovers = (audios || []).map((a) => a.coverImage || "");

  // Generate slug — append a short timestamp suffix if it already exists
  const slugBase = title
    ? slugify(title)
    : slugify(content.slice(0, 40)) || `post-${Date.now().toString(36)}`;
  let slug = slugBase;
  const existing = await prisma.post.findUnique({ where: { slug }, select: { id: true } });
  if (existing) {
    slug = `${slugBase}-${Date.now().toString(36)}`;
  }

  // Parse @mentions (fedi + bluesky) so we can render anchors and build AP tags
  const mentions = await parseMentions(content);

  // Render content HTML
  let contentHtml: string;
  if (isArticle) {
    contentHtml = sanitizeHtml(linkMentions(renderMarkdown(content), mentions));
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
    const withMentions = linkMentions(withLinks, mentions);
    contentHtml = `<p>${linkHashtags(withMentions).replace(/\n/g, "<br>")}</p>`;
  }

  // Schedule for later? A future scheduledFor creates the post unpublished; the
  // scheduler federates + crossposts it at that time.
  const scheduledForDate = scheduledFor ? new Date(scheduledFor) : null;
  const isScheduled =
    !!scheduledForDate && !isNaN(scheduledForDate.getTime()) && scheduledForDate.getTime() > Date.now();

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
      videos: videoUrls,
      videoTitles,
      videoThumbnails,
      audioPaths,
      audioTitles,
      audioCovers,
      published: !isScheduled,
      ...(isScheduled ? { publishedAt: scheduledForDate!, scheduledFor: scheduledForDate! } : {}),
      apId: `${siteUrl}/post/${slug}`,
      ...(parentPost ? { inReplyToPostId: parentPost.id } : {}),
    },
  });

  // Create Photo records if "Add to Photography" is toggled
  if (addToPhotography && photos && photos.length > 0) {
    for (let i = 0; i < photos.length; i++) {
      const photoSlug = `${slug}-photo-${i + 1}`;
      await prisma.photo.create({
        data: {
          slug: photoSlug,
          title: photos[i].alt || null,
          caption: photos[i].alt || null,
          imagePath: photos[i].url,
          category: photoCategory || "general",
          tags,
          published: !isScheduled,
          publishedAt: post.publishedAt,
          apId: `${siteUrl}/photography/${photoSlug}`,
        },
      }).catch(() => {
        // Ignore duplicate slug errors
      });
    }
  }

  // Create Video records if "Add to Videos" is toggled
  if (addToVideos && videos && videos.length > 0) {
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      const videoSlug = `${slug}-video-${i + 1}`;
      await prisma.video.create({
        data: {
          slug: videoSlug,
          title: v.title || null,
          embedUrl: v.url,
          embedHost: v.embedHost,
          embedId: v.embedId,
          iframeSrc: v.iframeSrc,
          thumbnailUrl: v.thumbnailUrl || null,
          duration: v.duration || null,
          category: videoCategory || "general",
          tags,
          published: !isScheduled,
          publishedAt: post.publishedAt,
          apId: `${siteUrl}/videos/${videoSlug}`,
        },
      }).catch(() => {
        // Ignore duplicate slug errors
      });
    }
  }

  // Create Audio records if "Add to Audio" is toggled
  if (addToAudio && audios && audios.length > 0) {
    for (let i = 0; i < audios.length; i++) {
      const a = audios[i];
      const audioSlug = `${slug}-audio-${i + 1}`;
      await prisma.audio.create({
        data: {
          slug: audioSlug,
          title: a.title || null,
          mp3Path: a.url,
          durationSec: a.durationSec || null,
          fileSize: a.fileSize || null,
          coverImage: a.coverImage || null,
          category: audioCategory || "general",
          tags,
          published: !isScheduled,
          publishedAt: post.publishedAt,
          apId: `${siteUrl}/audio/${audioSlug}`,
        },
      }).catch(() => {
        // Ignore duplicate slug errors
      });
    }
  }

  // Scheduled for later → created unpublished; the scheduler federates + crossposts
  // it (and flips its gallery rows) at scheduledFor. Skip immediate delivery.
  if (isScheduled) {
    return NextResponse.json({
      success: true,
      scheduled: true,
      post: {
        id: post.id,
        slug: post.slug,
        url: `${siteUrl}/post/${post.slug}`,
        scheduledFor: post.scheduledFor?.toISOString() ?? null,
      },
    });
  }

  // Build AP content for federation
  let apContent: string;
  if (isArticle) {
    // Article: send description + link, not full content
    const desc = description?.trim() || stripMarkdown(content).slice(0, 300);
    apContent = `<p>${desc.replace(/\n/g, "<br>")}</p>`;
  } else {
    apContent = contentHtml;
  }

  // Append video URLs to AP content as plain links so Mastodon shows link previews
  if (videos && videos.length > 0) {
    const videoLinks = videos
      .map((v) => `<p><a href="${v.url}" rel="nofollow noopener noreferrer">${v.url}</a></p>`)
      .join("\n");
    apContent = `${apContent}\n${videoLinks}`;
  }

  // Build AP attachment array for photos AND audio
  const apImageAttachments = [
    // Federate the cover image too (previously only inline photos were attached,
    // so a titled Article with a cover federated imageless). (#96)
    ...(post.coverImage && !(photos || []).some((p) => p.url === post.coverImage)
      ? [imageAttachment(post.coverImage)]
      : []),
    ...(photos || []).map((p) => {
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
    }),
  ];

  const apAudioAttachments = (audios || []).map((a) => {
    const url = a.url.startsWith("http") ? a.url : `${siteUrl}${a.url}`;
    return {
      type: "Document",
      mediaType: "audio/mpeg",
      url,
      name: a.title || "",
    };
  });

  const apAttachments = [...apImageAttachments, ...apAudioAttachments];

  // Build AP tag array for hashtags + Mention tags for fedi mentions
  const apTags: { type: string; href: string; name: string }[] = [
    ...tags.map((tag) => ({
      type: "Hashtag",
      href: `https://mastodon.social/tags/${tag}`,
      name: `#${tag}`,
    })),
    ...buildApMentionTags(mentions),
  ];

  // Extend CC list + direct-deliver inboxes for any mentioned fedi actors
  const mentionInboxes = collectMentionInboxes(mentions);
  const mentionActorUris = mentions.fedi
    .filter((m) => !!m.actorUri)
    .map((m) => m.actorUri!);

  // Federation
  const ccList = [`${siteUrl}/ap/followers`, ...mentionActorUris];
  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteUrl}/ap/create/${post.id}`,
    type: "Create",
    actor: `${siteUrl}/ap/actor`,
    published: post.publishedAt.toISOString(),
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: ccList,
    object: {
      type: isArticle ? "Article" : "Note",
      id: post.apId,
      attributedTo: `${siteUrl}/ap/actor`,
      ...(isArticle ? { name: title!.trim() } : {}),
      content: apContent,
      url: `${siteUrl}/post/${slug}`,
      published: post.publishedAt.toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: ccList,
      ...(parentPost?.apId ? { inReplyTo: parentPost.apId } : {}),
      ...(apAttachments.length > 0 ? { attachment: apAttachments } : {}),
      ...(apTags.length > 0 ? { tag: apTags } : {}),
    },
  };

  deliverToFollowers(activity).catch((err) =>
    console.error("Failed to federate post:", err)
  );

  // Direct-deliver to mentioned actors' inboxes so they get the notification
  for (const inbox of mentionInboxes) {
    deliverActivity(inbox, activity).catch((err) =>
      console.error(`Failed to deliver mention to ${inbox}:`, err)
    );
  }

  // Crossposting
  const postUrl = `${siteUrl}/post/${slug}`;
  const baseText = isArticle
    ? (description?.trim() || stripMarkdown(content).slice(0, 300))
    : content;
  // Threads has no embed API in our integration — append video URLs inline.
  let crosspostText = baseText;
  if (videos && videos.length > 0) {
    const videoLines = videos.map((v) => v.url).join("\n");
    crosspostText = `${crosspostText}\n\n${videoLines}`;
  }

  if (crosspostBluesky !== false) {
    // Build image list with full URLs for Bluesky upload
    const bskyImages = (photos || []).map((p) => ({
      url: p.url.startsWith("http") ? p.url : `${siteUrl}${p.url}`,
      alt: p.alt || "",
    }));
    // When no images attached, send the first video as an external link card.
    // In that case omit the video URL from the text to avoid duplicating it next to the card.
    const firstVideo = (bskyImages.length === 0 && videos && videos.length > 0)
      ? {
          url: videos[0].url,
          title: videos[0].title || "Video",
          description: baseText.slice(0, 300),
          thumbnailUrl: videos[0].thumbnailUrl || undefined,
        }
      : undefined;
    const bskyText = firstVideo ? baseText : crosspostText;
    try {
      const bskyResult = parentPost?.blueskyUri
        ? await crosspostReplyToBluesky(
            bskyText,
            parentPost.blueskyUri,
            postUrl,
            bskyImages.length > 0 ? bskyImages : undefined,
            firstVideo,
          )
        : await crosspostToBluesky(
            bskyText,
            postUrl,
            bskyImages.length > 0 ? bskyImages : undefined,
            firstVideo,
          );
      if (bskyResult.success && bskyResult.uri) {
        await prisma.post.update({
          where: { id: post.id },
          data: { blueskyUri: bskyResult.uri },
        });
      } else if (!bskyResult.success) {
        // #225: crosspost* returns { success:false } on a transient failure
        // (never throws) — log it (was discarded unlogged) AND persist for
        // retry so a Bluesky blip self-heals instead of silently losing the
        // crosspost. The scheduler re-attempts with backoff.
        console.error("Bluesky crosspost failed:", bskyResult.error);
        await enqueueFailedCrosspost(post.id, "bluesky", {
          text: bskyText,
          url: postUrl,
          images: bskyImages.length > 0 ? bskyImages : undefined,
          video: firstVideo,
          replyTo: parentPost?.blueskyUri ?? undefined,
        }, bskyResult.error);
      }
    } catch (err) {
      console.error("Bluesky crosspost error:", err);
    }
  }

  // Threads/DayOne don't have a useful threading model for follow-ups, so we
  // only fire them on top-level posts.
  if (!parentPost && crosspostThreads !== false) {
    // #225: crosspostToThreads returns { success:false } on failure (never
    // throws), so a bare .catch() only sees thrown errors — a failed crosspost
    // was silent. Log the returned error too.
    crosspostToThreads(crosspostText, postUrl)
      .then((r) => {
        if (!r.success) {
          console.error("Threads crosspost failed:", r.error);
          return enqueueFailedCrosspost(post.id, "threads", { text: crosspostText, url: postUrl }, r.error);
        }
      })
      .catch((err) => console.error("Threads crosspost error:", err));
  }

  if (!parentPost && crosspostDayOne !== false) {
    const dayOneImages = (photos || []).map((p) => {
      const url = p.url.startsWith("http") ? p.url : `${siteUrl}${p.url}`;
      const localPath = url.includes("/uploads/")
        ? path.join(process.cwd(), "public", new URL(url).pathname)
        : null;
      return { path: localPath, filename: url.split("/").pop() || "image.jpg" };
    }).filter((i) => i.path);

    crosspostToDayOne(content, postUrl, isArticle ? title!.trim() : undefined, dayOneImages)
      .then((r) => {
        if (!r.success) console.error("DayOne crosspost failed:", r.error);
      })
      .catch((err) => console.error("DayOne crosspost error:", err));
  }

  return NextResponse.json({
    success: true,
    post: { id: post.id, slug: post.slug, url: postUrl },
  });
}

interface EditInput {
  title?: string;
  content: string;
  description?: string;
  photos?: { url: string; alt: string }[];
  videos?: {
    url: string;
    title: string;
    embedHost: string;
    embedId: string;
    iframeSrc: string;
    thumbnailUrl?: string | null;
    duration?: number | null;
  }[];
  audios?: {
    url: string;
    title: string;
    durationSec?: number | null;
    fileSize?: number | null;
    coverImage?: string | null;
  }[];
}

async function updatePostHandler(postId: string, input: EditInput) {
  const existing = await prisma.post.findUnique({ where: { id: postId } });
  if (!existing) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  const isArticle = !!input.title?.trim();
  const tags = extractHashtags(input.content);
  // Media edits are OPT-IN (#202): an omitted field leaves the stored media
  // untouched (so a title/content-only edit can't wipe a post's photos/video/
  // audio); an explicit empty array clears it. See buildMediaUpdate.
  const mediaData = buildMediaUpdate(input);

  // Parse @mentions for the new content
  const mentions = await parseMentions(input.content);

  // Render content HTML (same logic as create)
  let contentHtml: string;
  if (isArticle) {
    contentHtml = sanitizeHtml(linkMentions(renderMarkdown(input.content), mentions));
  } else {
    const escaped = input.content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const withLinks = escaped.replace(
      /(https?:\/\/[^\s<&]+)/g,
      (url) => `<a href="${url}" rel="nofollow noopener noreferrer" target="_blank">${url}</a>`
    );
    const withMentions = linkMentions(withLinks, mentions);
    contentHtml = `<p>${linkHashtags(withMentions).replace(/\n/g, "<br>")}</p>`;
  }

  // Update (do NOT change slug or apId — they're identity-preserving)
  const updated = await prisma.post.update({
    where: { id: postId },
    data: {
      title: isArticle ? input.title!.trim() : null,
      content: input.content,
      contentHtml,
      excerpt: input.description?.trim() || null,
      category: isArticle ? "article" : existing.category,
      tags,
      ...mediaData,
    },
  });

  // Build AP Update activity
  let apContent: string;
  if (isArticle) {
    const desc = input.description?.trim() || stripMarkdown(input.content).slice(0, 300);
    apContent = `<p>${desc.replace(/\n/g, "<br>")}</p>`;
  } else {
    apContent = contentHtml;
  }
  // Federate the EFFECTIVE (post-update) media, not the raw input — so an edit
  // that omitted a media field still carries the preserved attachments in the
  // Update, instead of dropping them on the remote copy (#202).
  const effPhotos = updated.photos.map((url, i) => ({ url, alt: updated.photoCaptions[i] || "" }));
  const effAudios = updated.audioPaths.map((url, i) => ({ url, title: updated.audioTitles[i] || "" }));
  if (updated.videos.length > 0) {
    const videoLinks = updated.videos
      .map((url) => `<p><a href="${url}" rel="nofollow noopener noreferrer">${url}</a></p>`)
      .join("\n");
    apContent = `${apContent}\n${videoLinks}`;
  }

  const apImageAttachments = [
    ...(updated.coverImage && !effPhotos.some((p) => p.url === updated.coverImage)
      ? [imageAttachment(updated.coverImage)]
      : []),
    ...effPhotos.map((p) => {
      const url = p.url.startsWith("http") ? p.url : `${siteUrl}${p.url}`;
      const ext = url.split(".").pop()?.toLowerCase() || "jpg";
      const mimeMap: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
        webp: "image/webp", gif: "image/gif",
      };
      return { type: "Image", mediaType: mimeMap[ext] || "image/jpeg", url, name: p.alt || "" };
    }),
  ];
  const apAudioAttachments = effAudios.map((a) => {
    const url = a.url.startsWith("http") ? a.url : `${siteUrl}${a.url}`;
    return { type: "Document", mediaType: "audio/mpeg", url, name: a.title || "" };
  });
  const apAttachments = [...apImageAttachments, ...apAudioAttachments];

  const apTags: { type: string; href: string; name: string }[] = [
    ...tags.map((tag) => ({
      type: "Hashtag",
      href: `https://mastodon.social/tags/${tag}`,
      name: `#${tag}`,
    })),
    ...buildApMentionTags(mentions),
  ];
  const mentionInboxes = collectMentionInboxes(mentions);
  const mentionActorUris = mentions.fedi
    .filter((m) => !!m.actorUri)
    .map((m) => m.actorUri!);

  const now = new Date();
  const ccList = [`${siteUrl}/ap/followers`, ...mentionActorUris];
  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteUrl}/ap/update/${updated.id}/${Date.now()}`,
    type: "Update",
    actor: `${siteUrl}/ap/actor`,
    published: now.toISOString(),
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: ccList,
    object: {
      type: isArticle ? "Article" : "Note",
      id: updated.apId,
      attributedTo: `${siteUrl}/ap/actor`,
      ...(isArticle ? { name: input.title!.trim() } : {}),
      content: apContent,
      url: `${siteUrl}/post/${updated.slug}`,
      published: updated.publishedAt.toISOString(),
      updated: now.toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: ccList,
      ...(apAttachments.length > 0 ? { attachment: apAttachments } : {}),
      ...(apTags.length > 0 ? { tag: apTags } : {}),
    },
  };

  // #224: only federate an Update for a post that is ALREADY published. Editing
  // a draft or a not-yet-published scheduled post must not send its content to
  // followers — the row is updated silently, and the scheduler federates a
  // Create when it publishes. (An edit never flips `published`, so the pre-edit
  // state is the post's publication state.)
  if (existing.published) {
    deliverToFollowers(activity).catch((err) =>
      console.error("Failed to federate post update:", err)
    );
    for (const inbox of mentionInboxes) {
      deliverActivity(inbox, activity).catch((err) =>
        console.error(`Failed to deliver update to mentioned ${inbox}:`, err)
      );
    }
  }

  return NextResponse.json({
    success: true,
    post: { id: updated.id, slug: updated.slug, url: `${siteUrl}/post/${updated.slug}` },
    edited: true,
  });
}
