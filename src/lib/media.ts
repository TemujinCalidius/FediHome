import { writeFile, mkdir } from "fs/promises";
import path from "path";
import sharp from "sharp";

/**
 * Shared image handling (#59) — the optimise / EXIF-strip / write pipeline used
 * by both the authenticated media route and the setup-token-gated wizard upload.
 * Returns the RELATIVE `/uploads/…` path (not an absolute URL), so callers set at
 * different times (e.g. before SITE_URL is configured, during first-run setup)
 * can store a stable, origin-independent path.
 */

const MAX_DIMENSION = 2400; // px (longest edge)
const MAX_FILE_SIZE = 2 * 1024 * 1024; // optimise anything bigger
const WEBP_QUALITY = 85;

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic"];

export async function saveUploadedImage(
  file: File,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!IMAGE_TYPES.includes(file.type)) return { ok: false, error: "unsupported file type" };

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const uploadDir = path.join(process.cwd(), "public", "uploads", String(year), month);
  await mkdir(uploadDir, { recursive: true });

  const timestamp = Date.now().toString(36);
  let buffer: Buffer = Buffer.from(await file.arrayBuffer());
  let ext: string;

  try {
    // Optimise large images (skip GIFs to preserve animation).
    if (file.type !== "image/gif" && (buffer.length > MAX_FILE_SIZE || file.type === "image/heic")) {
      const image = sharp(buffer);
      const metadata = await image.metadata();
      let pipeline = image;
      if (metadata.width && metadata.height) {
        const longest = Math.max(metadata.width, metadata.height);
        if (longest > MAX_DIMENSION) {
          pipeline = pipeline.resize({
            width: metadata.width >= metadata.height ? MAX_DIMENSION : undefined,
            height: metadata.height > metadata.width ? MAX_DIMENSION : undefined,
            fit: "inside",
            withoutEnlargement: true,
          });
        }
      }
      buffer = (await pipeline.rotate().webp({ quality: WEBP_QUALITY }).toBuffer()) as Buffer;
      ext = "webp";
    } else if (file.type !== "image/gif") {
      // Strip EXIF from small images (GPS, camera serial, etc.).
      buffer = (await sharp(buffer).rotate().toBuffer()) as Buffer;
      const extFromMime: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
      ext = extFromMime[file.type] || "jpg";
    } else {
      ext = "gif";
    }
  } catch {
    // sharp can't decode it — a corrupt or mislabelled file. Caller's problem (400), not a 500.
    return { ok: false, error: "couldn't process that image — is it a valid file?" };
  }

  const filename = `${timestamp}.${ext}`;
  await writeFile(path.join(uploadDir, filename), buffer);
  return { ok: true, path: `/uploads/${year}/${month}/${filename}` };
}

/**
 * A safe same-origin image path — a prior `/uploads/…` upload or a built-in
 * `/images/…` asset — else null. Never an external URL (SSRF/hotlink) or a
 * traversal escape. `""`/`null` are treated as "clear to the default".
 */
export function validateImagePath(input: unknown): string | null | undefined {
  if (input === null || (typeof input === "string" && input.trim() === "")) return ""; // clear
  if (typeof input !== "string") return undefined; // invalid
  const p = input.trim();
  if (!/^\/(uploads|images)\/[A-Za-z0-9._/-]+$/.test(p) || p.includes("..")) return undefined;
  return p;
}
