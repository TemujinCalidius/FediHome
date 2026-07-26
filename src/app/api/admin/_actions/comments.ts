import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverToFollowers } from "@/lib/http-signatures";
import type { AdminBody } from "./types";
import { getSiteUrl } from "@/lib/identity";


export async function approveComment(body: AdminBody): Promise<NextResponse> {
  const { commentId } = body;
  const comment = await prisma.guestComment.update({
    where: { id: commentId },
    data: { status: "approved" },
    include: {
      post: { select: { apId: true } },
      photo: { select: { apId: true } },
    },
  });

  // Bridge to Fediverse — publish as reply from our actor
  const targetApId = comment.post?.apId || comment.photo?.apId;
  if (targetApId) {
    const noteId = `${getSiteUrl()}/ap/comment/${comment.id}`;
    // H3: HTML-escape guest-supplied content before embedding it in the
    // federated Note. Receivers re-sanitize, but unsanitized HTML on the
    // wire is still a stored-XSS waiting to happen on small fedi servers
    // and on our own site if rendering paths change.
    const escape = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const noteContent = `<p><strong>${escape(comment.guestName)}</strong> (via ${escape(new URL(getSiteUrl()).hostname)}):</p><p>${escape(comment.content)}</p>`;

    const activity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${getSiteUrl()}/ap/create/${comment.id}`,
      type: "Create",
      actor: `${getSiteUrl()}/ap/actor`,
      published: new Date().toISOString(),
      object: {
        type: "Note",
        id: noteId,
        attributedTo: `${getSiteUrl()}/ap/actor`,
        inReplyTo: targetApId,
        content: noteContent,
        published: new Date().toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [`${getSiteUrl()}/ap/followers`],
      },
    };

    await deliverToFollowers(activity).catch((err) =>
      console.error("Failed to federate comment:", err)
    );

    await prisma.guestComment.update({
      where: { id: comment.id },
      data: { federated: true },
    });
  }

  return NextResponse.json({ success: true });
}

export async function rejectComment(body: AdminBody): Promise<NextResponse> {
  const { commentId } = body;
  await prisma.guestComment.update({
    where: { id: commentId },
    data: { status: "rejected" },
  });
  return NextResponse.json({ success: true });
}
