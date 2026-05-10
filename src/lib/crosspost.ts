import { BskyAgent, RichText } from "@atproto/api";
import { readFile } from "fs/promises";
import path from "path";
import nodemailer from "nodemailer";

export interface CrosspostImage {
  url: string; // full URL or local path
  alt: string;
}

export interface CrosspostVideo {
  url: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
}

/**
 * Cross-post to Bluesky via AT Protocol.
 * Embed precedence: images (up to 4) > external video link card > none.
 */
export async function crosspostToBluesky(
  content: string,
  url?: string,
  images?: CrosspostImage[],
  video?: CrosspostVideo
): Promise<{ success: boolean; uri?: string; error?: string }> {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;

  if (!handle || !password) {
    return { success: false, error: "Bluesky credentials not configured" };
  }

  try {
    const agent = new BskyAgent({ service: "https://bsky.social" });
    await agent.login({ identifier: handle, password });

    // Truncate for Bluesky's 300 char limit
    let text = content;
    if (url) {
      const maxContentLen = 300 - url.length - 2;
      if (text.length > maxContentLen) {
        text = text.slice(0, maxContentLen - 3) + "...";
      }
      text = text + "\n\n" + url;
    } else if (text.length > 300) {
      text = text.slice(0, 297) + "...";
    }

    // Parse rich text (handles links, mentions, hashtags)
    const rt = new RichText({ text });
    await rt.detectFacets(agent);

    // Upload images if provided; otherwise fall back to video external embed.
    let embed = await buildBlueskyEmbed(agent, images);
    if (!embed && video) {
      embed = await buildBlueskyVideoEmbed(agent, video);
    }

    const result = await agent.post({
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
      ...(embed ? { embed } : {}),
    });

    return { success: true, uri: result.uri };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function buildBlueskyEmbed(
  agent: BskyAgent,
  images?: CrosspostImage[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  if (!images || images.length === 0) return null;

  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", gif: "image/gif",
  };

  const uploaded = [];
  for (const img of images.slice(0, 4)) {
    try {
      let buffer: Uint8Array;
      let contentType: string;

      // Try reading from local disk first (avoids race condition with file serving)
      const localPath = urlToLocalPath(img.url);
      if (localPath) {
        const fileBuffer = await readFile(localPath);
        buffer = new Uint8Array(fileBuffer);
        const ext = localPath.split(".").pop()?.toLowerCase() || "jpg";
        contentType = mimeMap[ext] || "image/jpeg";
      } else {
        // Fallback to HTTP fetch for external URLs
        const res = await fetch(img.url);
        if (!res.ok) continue;
        buffer = new Uint8Array(await res.arrayBuffer());
        contentType = res.headers.get("content-type") || "image/jpeg";
      }

      // Upload blob to Bluesky
      const uploadRes = await agent.uploadBlob(buffer, {
        encoding: contentType,
      });

      uploaded.push({
        alt: img.alt || "",
        image: uploadRes.data.blob,
      });
    } catch (err) {
      console.error("Bluesky image upload failed:", err);
    }
  }

  if (uploaded.length === 0) return null;

  return {
    $type: "app.bsky.embed.images",
    images: uploaded,
  };
}

async function buildBlueskyVideoEmbed(
  agent: BskyAgent,
  video: CrosspostVideo
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    webp: "image/webp", gif: "image/gif",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let thumb: any = undefined;
  if (video.thumbnailUrl) {
    try {
      const res = await fetch(video.thumbnailUrl);
      if (res.ok) {
        const buffer = new Uint8Array(await res.arrayBuffer());
        const ctHeader = res.headers.get("content-type") || "";
        const ext = video.thumbnailUrl.split("?")[0].split(".").pop()?.toLowerCase() || "";
        const contentType = ctHeader.startsWith("image/")
          ? ctHeader
          : (mimeMap[ext] || "image/jpeg");
        const uploadRes = await agent.uploadBlob(buffer, { encoding: contentType });
        thumb = uploadRes.data.blob;
      }
    } catch (err) {
      console.error("Bluesky video thumbnail upload failed:", err);
    }
  }

  const title = (video.title || "Video").slice(0, 300);
  const description = (video.description || "").slice(0, 1000);

  return {
    $type: "app.bsky.embed.external",
    external: {
      uri: video.url,
      title,
      description,
      ...(thumb ? { thumb } : {}),
    },
  };
}

/**
 * Cross-post to Threads via Meta's Threads API
 * Requires THREADS_ACCESS_TOKEN and THREADS_USER_ID env vars
 */
export async function crosspostToThreads(
  content: string,
  url?: string
): Promise<{ success: boolean; id?: string; error?: string }> {
  const accessToken = process.env.THREADS_ACCESS_TOKEN;
  const userId = process.env.THREADS_USER_ID;

  if (!accessToken || !userId) {
    return { success: false, error: "Threads credentials not configured" };
  }

  try {
    let text = content;
    if (url) text = text + "\n\n" + url;
    if (text.length > 500) text = text.slice(0, 497) + "...";

    // Step 1: Create media container
    const createRes = await fetch(
      `https://graph.threads.net/v1.0/${userId}/threads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "TEXT",
          text,
          access_token: accessToken,
        }),
      }
    );
    const createData = await createRes.json();
    if (!createData.id) throw new Error(JSON.stringify(createData));

    // Step 2: Publish
    const publishRes = await fetch(
      `https://graph.threads.net/v1.0/${userId}/threads_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creation_id: createData.id,
          access_token: accessToken,
        }),
      }
    );
    const publishData = await publishRes.json();

    return { success: true, id: publishData.id };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Cross-post to DayOne journal via email.
 * Sends markdown content with optional image attachments.
 */
export async function crosspostToDayOne(
  content: string,
  url: string,
  title?: string,
  images?: { path: string | null; filename: string }[]
): Promise<{ success: boolean; error?: string }> {
  const dayOneEmail = process.env.DAYONE_EMAIL;
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!dayOneEmail || !smtpHost || !smtpUser || !smtpPass) {
    return { success: false, error: "DayOne/SMTP not configured" };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    // Build email body: markdown content + link footer
    const siteHost = new URL(process.env.SITE_URL || "http://localhost:3000").hostname;
    const body = `${content}\n\n---\n[View on ${siteHost}](${url})`;

    // Build attachments from local image paths
    const attachments: { filename: string; path: string }[] = [];
    if (images) {
      for (const img of images) {
        if (img.path) {
          attachments.push({ filename: img.filename, path: img.path });
        }
      }
    }

    await transporter.sendMail({
      from: smtpUser,
      to: dayOneEmail,
      subject: title || "",
      text: body,
      attachments,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Convert a public URL to a local filesystem path.
 * e.g., "https://example.com/uploads/2026/03/x.webp" → "/path/to/public/uploads/2026/03/x.webp"
 * Returns null for external URLs.
 */
function urlToLocalPath(url: string): string | null {
  const siteUrl = process.env.SITE_URL || "http://localhost:3000";
  if (url.startsWith(siteUrl + "/uploads/")) {
    const relativePath = url.slice(siteUrl.length); // "/uploads/2026/03/x.webp"
    return path.join(process.cwd(), "public", relativePath);
  }
  if (url.startsWith("/uploads/")) {
    return path.join(process.cwd(), "public", url);
  }
  return null;
}
