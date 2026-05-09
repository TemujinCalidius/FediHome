import { NextResponse } from "next/server";
import { readFile, stat, open } from "fs/promises";
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
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

const RANGE_TYPES = new Set(["audio/mpeg", "audio/ogg", "audio/wav", "audio/mp4", "video/mp4", "video/webm"]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;
  const filePath = segments.join("/");

  // Prevent directory traversal
  if (filePath.includes("..") || filePath.startsWith("/")) {
    return new NextResponse("Not found", { status: 404 });
  }

  const fullPath = path.join(process.cwd(), "public", "uploads", filePath);
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const stats = await stat(fullPath);
    const fileSize = stats.size;
    const rangeHeader = req.headers.get("range");

    // Range request handling for media types
    if (rangeHeader && RANGE_TYPES.has(contentType)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1) : fileSize - 1;

        if (start >= fileSize || end >= fileSize || start > end) {
          return new NextResponse("Range not satisfiable", {
            status: 416,
            headers: { "Content-Range": `bytes */${fileSize}` },
          });
        }

        const chunkSize = end - start + 1;
        const handle = await open(fullPath, "r");
        try {
          const buf = Buffer.alloc(chunkSize);
          await handle.read(buf, 0, chunkSize, start);
          return new NextResponse(buf, {
            status: 206,
            headers: {
              "Content-Type": contentType,
              "Content-Length": String(chunkSize),
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Accept-Ranges": "bytes",
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          });
        } finally {
          await handle.close();
        }
      }
    }

    // Full-file response (advertise range support for media)
    const buffer = await readFile(fullPath);
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(fileSize),
      "Cache-Control": "public, max-age=31536000, immutable",
      "CDN-Cache-Control": "public, max-age=31536000, immutable",
    };
    if (RANGE_TYPES.has(contentType)) {
      headers["Accept-Ranges"] = "bytes";
    }
    return new NextResponse(buffer, { headers });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
