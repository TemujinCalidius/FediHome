import { writeFile, mkdir, readdir, stat, unlink } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { isPrivateUrl, assertPublicHost } from "./url-guard";

export { isPrivateUrl, assertPublicHost };

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECT_HOPS = 5;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB cap before Sharp ingestion (H9)
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_HTML_BYTES = 1 * 1024 * 1024; // 1MB for OG-fetch
// Cap Sharp's input pixel count to neutralize decompression bombs (M7).
const SHARP_MAX_PIXELS = 100_000_000;

/**
 * Fetch a URL with SSRF + size + redirect protection. Returns null on any
 * policy violation or transport error. Manually follows up to MAX_REDIRECT_HOPS
 * redirects, re-checking each hop against isPrivateUrl.
 */
async function safeFetch(
  url: string,
  opts: {
    maxBytes: number;
    accept?: string;
    contentTypePrefix?: string;
    rejectContentTypeContains?: string;
  }
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string } | null> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    // DNS-resolve and reject anything that points at private/loopback/etc.
    // Doing this on every redirect hop closes the rebinding/redirect-chain
    // SSRF (H1).
    if (!(await assertPublicHost(current))) return null;
    let res: Response;
    try {
      res = await fetch(current, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
        headers: opts.accept ? { Accept: opts.accept } : undefined,
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      try {
        current = new URL(loc, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") || "";
    if (opts.contentTypePrefix && !contentType.startsWith(opts.contentTypePrefix)) {
      return null;
    }
    if (
      opts.rejectContentTypeContains &&
      contentType.toLowerCase().includes(opts.rejectContentTypeContains)
    ) {
      return null;
    }

    const declared = parseInt(res.headers.get("content-length") || "0", 10);
    if (declared > opts.maxBytes) return null;

    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } catch {
      return null;
    }
    if (total === 0) return null;

    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { buffer, contentType, finalUrl: current };
  }
  return null;
}

export interface EmbedData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

/**
 * Download a remote image to public/uploads/fedi/YYYY/MM/<base36>.ext
 * Returns the local URL path or null on failure.
 */
export async function proxyImage(remoteUrl: string): Promise<string | null> {
  const result = await safeFetch(remoteUrl, {
    maxBytes: MAX_IMAGE_BYTES,
    accept: "image/*",
    contentTypePrefix: "image/",
    rejectContentTypeContains: "svg",
  });
  if (!result) return null;
  let buffer = result.buffer;
  const contentType = result.contentType;

  // Strip EXIF metadata; cap pixel count to defang decompression bombs.
  if (!contentType.includes("gif")) {
    try {
      buffer = (await sharp(buffer, { limitInputPixels: SHARP_MAX_PIXELS })
        .rotate()
        .toBuffer()) as Buffer;
    } catch {
      /* keep original if sharp fails */
    }
  }

  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  let ext = extMap[contentType] || "jpg";
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
}

/**
 * Download a remote video to public/uploads/fedi/YYYY/MM/<base36>.ext.
 * Max 50MB to avoid filling disk.
 */
export async function proxyVideo(remoteUrl: string): Promise<string | null> {
  const result = await safeFetch(remoteUrl, {
    maxBytes: MAX_VIDEO_BYTES,
    contentTypePrefix: "video/",
  });
  if (!result) return null;
  const { buffer, contentType } = result;

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

  trimFediStorage().catch(() => {});

  return `/uploads/fedi/${year}/${month}/${filename}`;
}

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
      const skipProxy = /youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|streamable\.com/i.test(url);
      if (skipProxy) {
        urls.push(url);
        types.push("video");
      } else {
        const localPath = await proxyVideo(url);
        urls.push(localPath || url);
        types.push("video");
      }
    } else if (mediaType.startsWith("image/") || !mediaType) {
      const localPath = await proxyImage(url);
      if (localPath) {
        urls.push(localPath);
        types.push("image");
      } else {
        urls.push(url);
        types.push("image");
      }
    }
  }

  return { urls, types };
}

/**
 * Extract first meaningful URL from HTML content and fetch OpenGraph metadata.
 */
export async function fetchLinkEmbed(htmlContent: string): Promise<EmbedData | null> {
  try {
    const allHrefs = htmlContent.matchAll(/href="(https?:\/\/[^"]+)"/g);
    let url: string | null = null;
    for (const match of allHrefs) {
      const candidate = match[1];
      if (candidate.match(/\/users\/[^/]+$/) || candidate.match(/\/@[^/]+$/)) continue;
      if (candidate.match(/\/tags\/[^/]+$/)) continue;
      if (/\.(jpg|jpeg|png|gif|webp|mp4|webm|mov|svg)(\?|$)/i.test(candidate)) continue;
      url = candidate;
      break;
    }
    if (!url) return null;

    const result = await safeFetch(url, {
      maxBytes: MAX_HTML_BYTES,
      accept: "text/html",
      contentTypePrefix: "text/html",
    });
    if (!result) return null;
    const html = result.buffer.toString("utf-8");

    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/)?.[1] ||
      html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:title"/)?.[1] || null;

    const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/)?.[1] ||
      html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:description"/)?.[1] || null;

    const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/)?.[1] ||
      html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:image"/)?.[1] || null;

    const ogSiteName = html.match(/<meta[^>]*property="og:site_name"[^>]*content="([^"]*)"/)?.[1] ||
      html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:site_name"/)?.[1] || null;

    const title = ogTitle || html.match(/<title>([^<]*)<\/title>/)?.[1] || null;
    const description = ogDesc ||
      html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/)?.[1] || null;

    if (!title && !description) return null;

    let localImage: string | null = null;
    if (ogImage) {
      try {
        const absoluteImage = ogImage.startsWith("http")
          ? ogImage
          : new URL(ogImage, result.finalUrl).href;
        localImage = await proxyImage(absoluteImage);
      } catch {
        localImage = null;
      }
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
  // Decode &amp; LAST: otherwise a literal "&amp;lt;" would be doubly-unescaped
  // to "<" instead of decoding to the intended "&lt;".
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}
