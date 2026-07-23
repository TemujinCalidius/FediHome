import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, verifyOrigin } from "@/lib/auth";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { parseBuffer as parseAudioMetadata } from "music-metadata";
import { saveUploadedImage, IMAGE_TYPES } from "@/lib/media";

// Audio cap (per-file)
const MAX_AUDIO_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(req: NextRequest) {
  // A `media`-scoped bearer (Micropub tokens carry it) OR the owner cookie.
  const auth = await authenticateApiRequest(req, "media");
  if (!auth.ok) {
    return auth.via === "bearer"
      ? NextResponse.json({ error: "insufficient_scope" }, { status: 403 })
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // The cookie is ambient → the web path still needs CSRF; a bearer isn't.
  if (auth.via === "cookie" && !verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "no file uploaded" }, { status: 400 });
  }

  const audioTypes = ["audio/mpeg", "audio/mp3"];

  // Audio path
  if (audioTypes.includes(file.type)) {
    return await handleAudioUpload(file);
  }

  // Image path — validation + optimise + write shared with the wizard (#59).
  if (!IMAGE_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "unsupported file type" }, { status: 400 });
  }
  const result = await saveUploadedImage(file);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const siteUrl = process.env.SITE_URL || "http://localhost:3000";
  const url = `${siteUrl}${result.path}`;
  return NextResponse.json({ url }, { status: 201, headers: { Location: url } });
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
