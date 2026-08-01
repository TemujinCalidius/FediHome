import { BskyAgent, RichText } from "@atproto/api";
import { getBlueskyCredentials, getThreadsCredentials } from "@/lib/integrations";
import { readFile } from "fs/promises";
import path from "path";
import nodemailer from "nodemailer";
import { isPrivateUrl } from "./url-guard";
import { getSiteUrl } from "./identity";
import { resolveUploadPath } from "./uploads-dir";
import { getDayOneCredentials } from "./integrations";
import { guardedFetch } from "./safe-fetch";

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
  const creds = await getBlueskyCredentials();
  if (!creds) {
    return { success: false, error: "Bluesky credentials not configured" };
  }
  const { handle, password } = creds;

  try {
    const agent = new BskyAgent({ service: "https://bsky.social" });
    await agent.login({ identifier: creds.did ?? handle, password });

    const text = truncateForBluesky(content, url);

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

/**
 * Cross-post a threaded reply to Bluesky. Used for author follow-ups: the new
 * post is attached as a reply under `parentBlueskyUri` so Bluesky renders it
 * as part of the same thread. If the parent is itself already a reply, the
 * thread root is preserved (AT Protocol requires `root` to point to the
 * top-level post of the conversation, not the immediate parent).
 */
export async function crosspostReplyToBluesky(
  content: string,
  parentBlueskyUri: string,
  url?: string,
  images?: CrosspostImage[],
  video?: CrosspostVideo,
): Promise<{ success: boolean; uri?: string; error?: string }> {
  const creds = await getBlueskyCredentials();
  if (!creds) {
    return { success: false, error: "Bluesky credentials not configured" };
  }
  const { handle, password } = creds;

  try {
    const agent = new BskyAgent({ service: "https://bsky.social" });
    await agent.login({ identifier: creds.did ?? handle, password });

    const uriParts = parentBlueskyUri.replace("at://", "").split("/");
    const repo = uriParts[0];
    const rkey = uriParts[uriParts.length - 1];

    const parentPost = (await agent.getPost({ repo, rkey })) as {
      uri: string;
      cid: string;
      value: Record<string, unknown>;
    };
    const parentCid = parentPost.cid;
    const parentReplyRef = parentPost.value.reply as
      | { root: { uri: string; cid: string }; parent: { uri: string; cid: string } }
      | undefined;
    const rootRef = parentReplyRef
      ? { uri: parentReplyRef.root.uri, cid: parentReplyRef.root.cid }
      : { uri: parentBlueskyUri, cid: parentCid };

    const text = truncateForBluesky(content, url);

    const rt = new RichText({ text });
    await rt.detectFacets(agent);

    let embed = await buildBlueskyEmbed(agent, images);
    if (!embed && video) {
      embed = await buildBlueskyVideoEmbed(agent, video);
    }

    const result = await agent.post({
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
      reply: {
        root: rootRef,
        parent: { uri: parentBlueskyUri, cid: parentCid },
      },
      ...(embed ? { embed } : {}),
    });

    return { success: true, uri: result.uri };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function truncateForBluesky(content: string, url?: string): string {
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
  return text;
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
      const localPath = await urlToLocalPath(img.url);
      if (localPath) {
        const fileBuffer = await readFile(localPath);
        buffer = new Uint8Array(fileBuffer);
        const ext = localPath.split(".").pop()?.toLowerCase() || "jpg";
        contentType = mimeMap[ext] || "image/jpeg";
      } else {
        // Fallback to HTTP fetch for external URLs
        // guardedFetch, not a bare fetch: this URL comes from the request body
        // (`photos[].url` on POST /api/compose, which a create-scoped app token can
        // set) and had NO guard at all — no host check, no timeout, no hop limit.
        // The sibling below at least checked isPrivateUrl. See safe-fetch.ts.
        const res = await guardedFetch(img.url, {
          crossOrigin: true, // an image URL legitimately redirects to a CDN
          label: "bluesky image",
          timeoutMs: 10_000,
          maxHops: 5,
        });
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
  if (video.thumbnailUrl && !isPrivateUrl(video.thumbnailUrl)) {
    try {
      // The isPrivateUrl check above is kept as a cheap string-only fast path, but
      // it was never sufficient on its own: it does no DNS, so a public hostname
      // resolving to 127.0.0.1 passed it, and it saw only the first hop.
      // guardedFetch does both. See safe-fetch.ts.
      const res = await guardedFetch(video.thumbnailUrl, {
        crossOrigin: true,
        label: "bluesky video thumbnail",
        timeoutMs: 10_000,
        maxHops: 5,
      });
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
  const creds = await getThreadsCredentials();
  if (!creds) {
    return { success: false, error: "Threads credentials not configured" };
  }
  const { accessToken, userId } = creds;

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
  // DB first, env as the fallback (#326) — so the SMTP password can be changed
  // from the admin panel, and is encrypted at rest like every other credential.
  const creds = await getDayOneCredentials();
  if (!creds) {
    return { success: false, error: "DayOne/SMTP not configured" };
  }
  const { dayOneEmail, host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass } = creds;

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    // Build email body: markdown content + link footer
    const siteHost = new URL(getSiteUrl()).hostname;
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
 *
 * M2: resolve the path and reject anything that escapes `public/uploads`. A
 * URL like `${SITE_URL}/uploads/../../etc/passwd` would otherwise read /etc/passwd
 * and ship it to Bluesky as a "photo".
 */
async function urlToLocalPath(url: string): Promise<string | null> {
  const siteUrl = getSiteUrl();
  let relativePath: string | null = null;
  if (url.startsWith(siteUrl + "/uploads/")) {
    relativePath = url.slice(siteUrl.length);
  } else if (url.startsWith("/uploads/")) {
    relativePath = url;
  }
  if (!relativePath) return null;

  // Containment is enforced inside resolveUploadPath, against both the
  // configured root and the legacy one (audit finding M2, #363).
  return resolveUploadPath(relativePath);
}
