import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildPostObject } from "@/lib/ap-post";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const post = await prisma.post.findUnique({
    where: { slug },
    include: { inReplyTo: { select: { apId: true } } },
  });
  if (!post || !post.published || !post.apId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const object = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    ...buildPostObject(post),
  };

  return NextResponse.json(object, {
    headers: {
      "Content-Type": "application/activity+json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
