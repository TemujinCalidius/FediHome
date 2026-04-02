import { NextRequest, NextResponse } from "next/server";
import { verifyMicropubToken, verifyAdmin } from "@/lib/auth";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import sharp from "sharp";

// Images larger than this get optimized
const MAX_DIMENSION = 2400; // px (longest edge)
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB — optimize anything bigger
const WEBP_QUALITY = 85;

export async function POST(req: NextRequest) {
  // Accept either Micropub token or admin cookie
  const auth = await verifyMicropubToken(req.headers.get("authorization"));
  if (!auth.valid && !verifyAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "no file uploaded" }, { status: 400 });
  }

  // Validate file type
  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
  ];
  if (!allowedTypes.includes(file.type)) {
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

    buffer = await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer();
    ext = "webp";
  } else {
    ext = file.name.split(".").pop() || "jpg";
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
