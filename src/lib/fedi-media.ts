import { writeFile, mkdir, readdir, stat, unlink } from "fs/promises";
import path from "path";

export interface EmbedData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null; // local proxied path
  siteName: string | null;
}

/**
 * Download a remote image to public/uploads/fedi/YYYY/MM/<base36>.ext
 * Returns the local URL path (e.g., /uploads/fedi/2026/03/abc123.jpg)
 */
export async function proxyImage(remoteUrl: string): Promise<string | null> {
  try {
    const res = await fetch(remoteUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "image/*" },
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) return null;

    // Determine extension from content-type
    const extMap: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/svg+xml": "svg",
    };
    let ext = extMap[contentType] || "jpg";
    // Fallback: try from URL
    if (!extMap[contentType]) {
      const urlExt = remoteUrl.split("?")[0].split(".").pop()?.toLowerCase();
      if (urlExt && ["jpg", "jpeg", "png", "webp", "gif"].includes(urlExt)) {
        ext = urlExt === "jpeg" ? "jpg" : urlExt;
      }
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const uploadDir = path.join(process.cwd(), "public", "uploads", "fedi", String(year), month);
    await mkdir(uploadDir, { recursive: true });

    const filename = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const filePath = path.join(uploadDir, filename);
    await writeFile(filePath, buffer);

    return `/uploads/fedi/${year}/${month}/${filename}`;
  } catch {
    return null;
  }
}

/**
 * Download a remote video to public/uploads/fedi/YYYY/MM/<base36>.ext
 * Returns the local URL path or null on failure.
 * Max 50MB per video to avoid filling disk.
 */
export async function proxyVideo(remoteUrl: string): Promise<string | null> {
  try {
    const res = await fetch(remoteUrl, {
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("video/")) return null;

    // Check content-length before downloading if available
    const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
    if (contentLength > 50 * 1024 * 1024) return null; // skip >50MB

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > 50 * 1024 * 1024) return null;

    const extMap: Record<string, string> = {
      "video/mp4": "mp4",
      "video/webm": "webm",
      "video/ogg": "ogg",
      "video/quicktime": "mov",
    };
    let ext = extMap[contentType] || "mp4";
    if (!extMap[contentType]) {
      const urlExt = remoteUrl.split("?")[0].split(".").pop()?.toLowerCase();
      if (urlExt && ["mp4", "webm", "ogg", "mov"].includes(urlExt)) {
        ext = urlExt;
      }
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const uploadDir = path.join(process.cwd(), "public", "uploads", "fedi", String(year), month);
    await mkdir(uploadDir, { recursive: true });

    const filename = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const filePath = path.join(uploadDir, filename);
    await writeFile(filePath, buffer);

    // Run cleanup in background (don't await)
    trimFediStorage().catch(() => {});

    return `/uploads/fedi/${year}/${month}/${filename}`;
  } catch {
    return null;
  }
}

/**
 * Keep total fedi media storage under a size limit.
 * Deletes oldest files first until under the cap.
 * Default limit: 2GB
 */
const STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

async function getAllFiles(dir: string): Promise<{ path: string; mtimeMs: number; size: number }[]> {
  const files: { path: string; mtimeMs: number; size: number }[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await getAllFiles(fullPath));
      } else {
        const s = await stat(fullPath);
        files.push({ path: fullPath, mtimeMs: s.mtimeMs, size: s.size });
      }
    }
  } catch {
    // directory doesn't exist yet
  }
  return files;
}

export async function trimFediStorage(): Promise<{ deleted: number; freedBytes: number }> {
  const baseDir = path.join(process.cwd(), "public", "uploads", "fedi");
  const files = await getAllFiles(baseDir);

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize <= STORAGE_LIMIT_BYTES) return { deleted: 0, freedBytes: 0 };

  // Sort oldest first
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let currentSize = totalSize;
  let deleted = 0;
  let freedBytes = 0;

  for (const file of files) {
    if (currentSize <= STORAGE_LIMIT_BYTES) break;
    try {
      await unlink(file.path);
      currentSize -= file.size;
      freedBytes += file.size;
      deleted++;
    } catch {
      // skip files that can't be deleted
    }
  }

  return { deleted, freedBytes };
}

/**
 * Process AP attachment array.
 * Images and videos get proxied locally.
 */
export async function processAttachments(
  attachments: unknown[] | undefined
): Promise<{ urls: string[]; types: string[] }> {
  const urls: string[] = [];
  const types: string[] = [];

  if (!Array.isArray(attachments)) return { urls, types };

  for (const att of attachments) {
    const a = att as Record<string, unknown>;
    const url = a.url as string | undefined;
    if (!url) continue;

    const mediaType = (a.mediaType as string) || "";

    if (mediaType.startsWith("video/")) {
      // Skip proxying for major video platforms — they handle their own delivery
      const skipProxy = /youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|streamable\.com/i.test(url);
      if (skipProxy) {
        urls.push(url);
        types.push("video");
      } else {
        // Proxy fedi server videos locally for reliable playback
        const localPath = await proxyVideo(url);
        urls.push(localPath || url);
        types.push("video");
      }
    } else if (mediaType.startsWith("image/") || !mediaType) {
      // Default to image if no mediaType specified
      const localPath = await proxyImage(url);
      if (localPath) {
        urls.push(localPath);
        types.push("image");
      } else {
        // Fallback: keep remote URL if proxy fails
        urls.push(url);
        types.push("image");
      }
    }
  }

  return { urls, types };
}

/**
 * Extract first meaningful URL from HTML content and fetch OpenGraph metadata.
 * Returns null if no link found or fetch fails.
 */
export async function fetchLinkEmbed(htmlContent: string): Promise<EmbedData | null> {
  try {
    // Extract all href URLs from HTML content
    const allHrefs = htmlContent.matchAll(/href="(https?:\/\/[^"]+)"/g);
    let url: string | null = null;

    for (const match of allHrefs) {
      const candidate = match[1];
      // Skip @mention links (Mastodon wraps usernames in links to their profile)
      if (candidate.match(/\/users\/[^/]+$/) || candidate.match(/\/@[^/]+$/)) continue;
      // Skip hashtag links
      if (candidate.match(/\/tags\/[^/]+$/)) continue;
      // Skip media URLs (images, videos)
      if (/\.(jpg|jpeg|png|gif|webp|mp4|webm|mov|svg)(\?|$)/i.test(candidate)) continue;
      url = candidate;
      break;
    }

    if (!url) return null;

    // Block SSRF — reject private/internal IPs
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      if (
        host === "localhost" ||
        host.startsWith("127.") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        host.startsWith("172.16.") ||
        host.startsWith("172.17.") ||
        host.startsWith("172.18.") ||
        host.startsWith("172.19.") ||
        host.startsWith("172.2") ||
        host.startsWith("172.30.") ||
        host.startsWith("172.31.") ||
        host === "169.254.169.254" ||
        host.endsWith(".local") ||
        host === "[::1]" ||
        host === "0.0.0.0"
      ) {
        return null;
      }
    } catch {
      return null;
    }

    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: "text/html",
        "User-Agent": "FediHome embed fetcher",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;

    const html = await res.text();

    // Parse OpenGraph meta tags
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/)
      ?.[1] || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:title"/)
      ?.[1] || null;

    const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/)
      ?.[1] || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:description"/)
      ?.[1] || null;

    const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/)
      ?.[1] || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:image"/)
      ?.[1] || null;

    const ogSiteName = html.match(/<meta[^>]*property="og:site_name"[^>]*content="([^"]*)"/)
      ?.[1] || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:site_name"/)
      ?.[1] || null;

    // Fall back to <title> if no og:title
    const title = ogTitle || html.match(/<title>([^<]*)<\/title>/)?.[1] || null;
    const description = ogDesc || html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/)
      ?.[1] || null;

    if (!title && !description) return null;

    // Proxy the OG image locally
    let localImage: string | null = null;
    if (ogImage) {
      // Resolve relative URLs
      const absoluteImage = ogImage.startsWith("http")
        ? ogImage
        : new URL(ogImage, url).href;
      localImage = await proxyImage(absoluteImage);
    }

    return {
      url,
      title: title ? decodeHtmlEntities(title) : null,
      description: description ? decodeHtmlEntities(description) : null,
      image: localImage,
      siteName: ogSiteName ? decodeHtmlEntities(ogSiteName) : null,
    };
  } catch {
    return null;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'");
}
