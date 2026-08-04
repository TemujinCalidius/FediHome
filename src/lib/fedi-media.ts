import { writeFile, mkdir, readdir, stat, unlink } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { isPrivateUrl, assertPublicHost } from "./url-guard";
import { guardedFetch } from "./safe-fetch";
import {
  ensureUploadDir,
  uploadsDir,
  resolveUploadPath,
  fediCacheBudgetBytes,
  remoteMediaCachingEnabled,
  uploadsRoots,
} from "./uploads-dir";

export { isPrivateUrl, assertPublicHost };

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECT_HOPS = 5;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB cap before Sharp ingestion (H9)
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_HTML_BYTES = 1 * 1024 * 1024; // 1MB for OG-fetch
// Cap Sharp's input pixel count to neutralize decompression bombs (M7).
const SHARP_MAX_PIXELS = 100_000_000;

/**
 * Fetch a URL with SSRF + size + redirect protection. Returns null on any policy
 * violation or transport error.
 *
 * Redirects and the per-hop host check are delegated to `guardedFetch`
 * (safe-fetch.ts); this function owns the byte cap and content-type rules, which
 * are specific to media and apply to the final response only.
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
  // The hop-following and per-hop host check now live in safe-fetch.ts, which was
  // written from THIS loop after eight sibling call sites turned out to be missing
  // it. Delegating rather than keeping a second copy is the whole point — see the
  // note in safe-fetch.ts about a rule that only some paths enforce.
  let res: Response;
  try {
    res = await guardedFetch(url, {
      crossOrigin: true, //  media legitimately redirects to a CDN on another host
      label: "media fetch",
      timeoutMs: FETCH_TIMEOUT_MS,
      maxHops: MAX_REDIRECT_HOPS,
      init: opts.accept ? { headers: { Accept: opts.accept } } : {},
    });
  } catch {
    return null;
  }

  const finalUrl = res.url || url;
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
  return { buffer, contentType, finalUrl };
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
  // Budget 0 means cache nothing (#364). Refused HERE, at the one entry point,
  // rather than at each caller: returning null makes every caller fall back to
  // the remote URL, which is the behaviour they already have for a proxy failure.
  if (!(await remoteMediaCachingEnabled())) return null;
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
  const uploadDir = await ensureUploadDir("fedi", String(year), month);

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
  const uploadDir = await ensureUploadDir("fedi", String(year), month);

  const filename = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const filePath = path.join(uploadDir, filename);
  await writeFile(filePath, buffer);

  // Trimming used to happen here, fire-and-forget after every cached video —
  // which meant an instance that only ever cached IMAGES never trimmed at all,
  // and the budget below was fiction. The scheduler's storage scan does it now,
  // on a walk it is already performing to measure usage (#385).

  return `/uploads/fedi/${year}/${month}/${filename}`;
}


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
  // Every root, not just the current one (#479). Trimming the legacy root is
  // safe for exactly the reason serving from it is: it only ever holds proxied
  // remote media under fedi/, never the operator's own uploads.
  const roots = await uploadsRoots();
  const files = (
    await Promise.all(roots.map((r) => getAllFiles(path.join(r, "fedi"))))
  ).flat();

  // Operator-set since #364; 2GB was hardcoded before that, and remains the
  // default so an upgrade changes nothing. A budget of 0 means "cache nothing",
  // and the comparison below reads correctly for it — everything is over budget,
  // so everything goes.
  const limit = await fediCacheBudgetBytes();
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize <= limit) return { deleted: 0, freedBytes: 0 };

  // Oldest-WRITTEN first, not least-recently-USED. Nothing in the codebase ever
  // touches atime on a read, so there is no access information to sort by — a
  // file fetched every day is evicted at the same age as one never seen again.
  // Called out because the eviction is routinely described as LRU and is not.
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let currentSize = totalSize;
  let deleted = 0;
  let freedBytes = 0;

  const evicted: string[] = [];
  for (const file of files) {
    if (currentSize <= limit) break;
    try {
      await unlink(file.path);
      evicted.push(file.path);
      currentSize -= file.size;
      freedBytes += file.size;
      deleted++;
    } catch {
      // skip files that can't be deleted
    }
  }

  if (evicted.length > 0) await restoreEvictedMedia(evicted);
  return { deleted, freedBytes };
}

/**
 * Put every post that referenced an evicted file back to loading from source
 * (#478).
 *
 * Before this, the trim unlinked the file and changed nothing else. The remote
 * original was discarded at proxy time, so the picture was simply gone — and
 * eviction is by age, so it took the oldest media first: posts far enough down
 * the timeline that nobody scrolls to them today. The damage appeared
 * gradually, in old posts, long after the trim that caused it.
 *
 * Rows written before `mediaRemoteUrls` existed have an empty array and are left
 * alone. There is nothing to restore them FROM — the URL was never recorded —
 * and rewriting them to "" would replace a broken image with a missing one while
 * destroying the record that there had been an image at all.
 */
async function restoreEvictedMedia(paths: string[]): Promise<void> {
  // Disk paths → the /uploads/... URLs the rows actually store. Matching on the
  // stored URL rather than the path is what makes this work across BOTH roots
  // (#479): a file under the legacy root is served from the same /uploads URL.
  const urls = paths
    .map((p) => {
      const i = p.lastIndexOf("/uploads/");
      return i === -1 ? null : p.slice(i);
    })
    .filter((u): u is string => u !== null);
  if (urls.length === 0) return;

  try {
    const { prisma } = await import("./db");
    const rows = await prisma.fediPost.findMany({
      where: { mediaUrls: { hasSome: urls } },
      select: { id: true, mediaUrls: true, mediaRemoteUrls: true },
    });
    const gone = new Set(urls);

    for (const row of rows) {
      // A row whose parallel array is short or absent is left untouched rather
      // than half-rewritten by index — that would silently pair a URL with
      // another attachment's original.
      if (row.mediaRemoteUrls.length !== row.mediaUrls.length) continue;
      const next = row.mediaUrls.map((u, i) =>
        gone.has(u) && row.mediaRemoteUrls[i] ? row.mediaRemoteUrls[i] : u,
      );
      if (next.some((u, i) => u !== row.mediaUrls[i])) {
        await prisma.fediPost.update({ where: { id: row.id }, data: { mediaUrls: next } });
      }
    }
  } catch (err) {
    // Never let this fail the sweep. The files are already gone; a database
    // problem here means some posts show a broken image, which is exactly the
    // state everything was in before this existed.
    console.error("[fedihome] #478 restore after cache eviction failed:", err);
  }
}

/**
 * Reclaim cached remote media for pruned posts (#240). Only removes files we
 * proxied under public/uploads/fedi/ — remote passthrough URLs (skip-proxy
 * video hosts, proxy fallbacks) and remote avatars are left untouched. Each
 * path is resolved and confirmed to stay INSIDE the fedi media dir before
 * unlink, so a poisoned "/uploads/fedi/../.." value can't escape the tree.
 * Best-effort per file (an already-gone file never throws). Returns the count
 * actually removed.
 */
export async function removeFediMediaFiles(urls: string[]): Promise<number> {
  let removed = 0;
  for (const url of urls) {
    if (typeof url !== "string" || !url.startsWith("/uploads/fedi/")) continue;
    // resolveUploadPath does the containment check against BOTH roots, so a
    // poisoned "/uploads/fedi/../.." value still can't escape, and media written
    // before the directory moved is still cleaned up.
    const abs = await resolveUploadPath(url);
    if (!abs) continue;
    try {
      await unlink(abs);
      removed++;
    } catch {
      // already gone / unreadable — best effort
    }
  }
  return removed;
}

export async function processAttachments(
  attachments: unknown[] | undefined
): Promise<{ urls: string[]; types: string[]; remotes: string[] }> {
  const urls: string[] = [];
  const types: string[] = [];
  // The original URL for each entry, parallel to `urls` (#478). Kept so the
  // cache trim can put a post back to loading from source rather than leaving a
  // broken image — proxying used to discard it, so an evicted file was gone for
  // good. Pushed for EVERY branch, including passthrough ones where it equals
  // the stored URL, because a parallel array that is sometimes short is worse
  // than no array at all.
  const remotes: string[] = [];

  if (!Array.isArray(attachments)) return { urls, types, remotes };

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
      remotes.push(url);
    } else if (mediaType.startsWith("image/") || !mediaType) {
      const localPath = await proxyImage(url);
      urls.push(localPath || url);
      types.push("image");
      remotes.push(url);
    }
  }

  return { urls, types, remotes };
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
