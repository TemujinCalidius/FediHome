import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  const filePath = segments.join("/");

  // Prevent directory traversal
  if (filePath.includes("..") || filePath.startsWith("/")) {
    return new NextResponse("Not found", { status: 404 });
  }

  const fullPath = path.join(process.cwd(), "public", "uploads", filePath);

  try {
    const buffer = await readFile(fullPath);
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "CDN-Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
