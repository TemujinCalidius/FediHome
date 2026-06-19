import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import crypto from "crypto";
import { verifyOrigin } from "@/lib/auth";
import { sendPushToOwner } from "@/lib/push";

export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Cap the body before parsing: a name (<=100) + comment (<=2000) plus the JSON
  // envelope is far under 64 KB, so reject anything larger up front rather than
  // buffering a huge unauthenticated payload into memory (DoS).
  const MAX_BODY = 64 * 1024;
  if (Number(req.headers.get("content-length")) > MAX_BODY) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const body = await req.json();
  const { guestName, guestEmail, content, postId, photoId, website } = body;

  // Honeypot check — bots fill this hidden field
  if (website) {
    // Silently accept but don't store — bot doesn't know it failed
    return NextResponse.json({ success: true });
  }

  if (!guestName?.trim() || !content?.trim()) {
    return NextResponse.json(
      { error: "Name and comment are required." },
      { status: 400 }
    );
  }

  if (!postId && !photoId) {
    return NextResponse.json(
      { error: "Must specify a post or photo." },
      { status: 400 }
    );
  }

  if (guestName.length > 100 || content.length > 2000) {
    return NextResponse.json(
      { error: "Name or comment too long." },
      { status: 400 }
    );
  }

  // Rate limiting — hash the IP. Trust forwarded headers only when a known
  // reverse proxy is in front (H3): otherwise an attacker rotates XFF values
  // to mint unlimited buckets and defeat the limit.
  const trustProxy = process.env.TRUSTED_PROXY === "true";
  const ip = trustProxy
    ? (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
       req.headers.get("x-real-ip") ||
       "unknown")
    : "default";
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex");

  // Check rate: max 3 comments per IP per hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCount = await prisma.guestComment.count({
    where: { ipHash, createdAt: { gt: oneHourAgo } },
  });

  if (recentCount >= 3) {
    return NextResponse.json(
      { error: "Too many comments. Please try again later." },
      { status: 429 }
    );
  }

  await prisma.guestComment.create({
    data: {
      guestName: guestName.trim(),
      guestEmail: guestEmail?.trim() || null,
      content: content.trim(),
      ipHash,
      postId: postId || null,
      photoId: photoId || null,
    },
  });

  void sendPushToOwner({
    title: "New comment",
    body: `${guestName.trim()} left a comment (awaiting approval)`,
    url: "/timeline",
    type: "comment",
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
