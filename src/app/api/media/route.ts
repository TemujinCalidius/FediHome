import { NextRequest, NextResponse } from "next/server";
import { verifyMicropubToken, verifyAdmin } from "@/lib/auth";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { parseBuffer as parseAudioMetadata } from "music-metadata";

// Images larger than this get optimized
const MAX_DIMENSION = 2400; // px (longest edge)
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB — optimize anything bigger
const WEBP_QUALITY = 85;

// Audio cap (per-file)
const MAX_AUDIO_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(req: NextRequest) {
  // Accept either Micropub token or admin cookie
  const auth = await verifyMicropubToken(req.headers.get("authorization"));
  if (!auth.valid && !(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "no file uploaded" }, { status: 400 });
  }

  const imageTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
  ];
  const audioTypes = ["audio/mpeg", "audio/mp3"];

  // Audio path
  if (audioTypes.includes(file.type)) {
    return await handleAudioUpload(file);
  }

  // Image path
  if (!imageTypes.includes(file.type)) {
    return NextResponse.json({ error: "unsupported file type" }, { status: 400 });
  }

  // Create upload directory
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const uploadDir = path.join(process.cwd(), "public", "uploads", String(year), month);
  await mkdir(uploadDir, { recursive: true });

  const timestamp = Date.now().toString(36);
  let buffer: Buffer = Buffer.from(await file.arrayBuffer()) as Buffer;

  // Optimize if image is large (skip GIFs to preserve animation)
  let ext: string;
  if (file.type !== "image/gif" && (buffer.length > MAX_FILE_SIZE || file.type === "image/heic")) {
    // Resize + convert to WebP
    const image = sharp(buffer);
    const metadata = await image.metadata();

    let pipeline = image;

    // Resize if dimensions exceed max
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

    buffer = await pipeline.rotate().webp({ quality: WEBP_QUALITY }).toBuffer();
    ext = "webp";
  } else if (file.type !== "image/gif") {
    // Strip EXIF from small images (GPS, camera serial, etc.)
    buffer = await sharp(buffer).rotate().toBuffer();
    const extFromMime: Record<string, string> = {
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
    };
    ext = extFromMime[file.type] || "jpg";
  } else {
    ext = "gif";
  }

  const filename = `${timestamp}.${ext}`;
  const filePath = path.join(uploadDir, filename);
  await writeFile(filePath, buffer);

  const siteUrl = process.env.SITE_URL || "http://localhost:3000";
  const url = `${siteUrl}/uploads/${year}/${month}/${filename}`;

  return NextResponse.json({ url }, {
    status: 201,
    headers: { Location: url },
  });
}

async function handleAudioUpload(file: File): Promise<NextResponse> {
  const buffer = Buffer.from(await file.arrayBuffer());

  if (buffer.length > MAX_AUDIO_SIZE) {
    return NextResponse.json(
      { error: `audio file too large (max ${Math.round(MAX_AUDIO_SIZE / 1024 / 1024)}MB)` },
      { status: 400 }
    );
  }

  // Probe metadata for duration (best-effort — file still saved if probing fails)
  let durationSec: number | null = null;
  try {
    const meta = await parseAudioMetadata(buffer, { mimeType: file.type });
    if (meta.format.duration) {
      durationSec = Math.round(meta.format.duration);
    }
  } catch {
    // ignore — keep durationSec null
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const audioDir = path.join(process.cwd(), "public", "uploads", "audio", String(year), month);
  await mkdir(audioDir, { recursive: true });

  const timestamp = Date.now().toString(36);
  const filename = `${timestamp}.mp3`;
  const filePath = path.join(audioDir, filename);
  await writeFile(filePath, buffer);

  const siteUrl = process.env.SITE_URL || "http://localhost:3000";
  const url = `${siteUrl}/uploads/audio/${year}/${month}/${filename}`;

  return NextResponse.json(
    { url, durationSec, fileSize: buffer.length, kind: "audio" },
    {
      status: 201,
      headers: { Location: url },
    }
  );
}
