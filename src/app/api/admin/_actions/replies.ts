import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverActivity, deliverToFollowers } from "@/lib/http-signatures";
import { siteConfig } from "@/../site.config";
import { parseMentions, linkMentions, buildApMentionTags, collectMentionInboxes } from "@/lib/mentions";
import { resolveActorInbox, originalApId } from "@/lib/fedi-resolve";
import type { AdminBody } from "./types";
import { getSiteUrl } from "@/lib/identity";


export async function reply(body: AdminBody): Promise<NextResponse> {
  // Reply to a Fedi post/comment from the admin panel
  const {
    content: replyContent,
    inReplyTo,
    targetInbox,
    actorUri: replyActorUri,
    mentionHandle,
    crosspostBluesky: replyCrosspostBluesky,
  } = body;
  if (!replyContent || !inReplyTo) {
    return NextResponse.json({ error: "content and inReplyTo required" }, { status: 400 });
  }

  // Strip a leading copy of the recipient handle so the server-side mention
  // HTML prepend below doesn't duplicate it when the client prefilled the textarea.
  let bodyText: string = replyContent;
  if (mentionHandle && typeof bodyText === "string") {
    const handle = String(mentionHandle).trim();
    const trimmed = bodyText.trimStart();
    if (handle && trimmed.startsWith(handle)) {
      bodyText = trimmed.slice(handle.length).replace(/^\s+/, "");
    }
  }

  // Parse @mentions from the user's text (fedi + bluesky)
  const replyMentions = await parseMentions(bodyText);

  // Auto-link URLs in plain text content
  const linkedContent = bodyText.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url: string) => `<a href="${url}" rel="nofollow noopener noreferrer" target="_blank">${url}</a>`
  );
  const withMentions = linkMentions(linkedContent, replyMentions);

  // Build mention HTML for the person we're replying to (h-card style — Mastodon-friendly)
  const mentionUsername = mentionHandle ? mentionHandle.split("@")[1] : null;
  const mentionHtml = replyActorUri && mentionUsername
    ? `<span class="h-card"><a href="${replyActorUri}" class="u-url mention">@<span>${mentionUsername}</span></a></span> `
    : "";
  const contentHtml = `<p>${mentionHtml}${withMentions}</p>`;

  const replyId = `${getSiteUrl()}/ap/reply/${Date.now()}`;
  const ccList = [`${getSiteUrl()}/ap/followers`];
  if (replyActorUri) ccList.push(replyActorUri);
  for (const m of replyMentions.fedi) {
    if (m.actorUri && !ccList.includes(m.actorUri)) ccList.push(m.actorUri);
  }

  const tags: { type: string; href: string; name: string }[] = [];
  if (replyActorUri && mentionHandle) {
    tags.push({ type: "Mention", href: replyActorUri, name: mentionHandle });
  }
  for (const t of buildApMentionTags(replyMentions)) {
    if (!tags.some((existing) => existing.href === t.href)) tags.push(t);
  }

  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${getSiteUrl()}/ap/create/reply-${Date.now()}`,
    type: "Create",
    actor: `${getSiteUrl()}/ap/actor`,
    published: new Date().toISOString(),
    object: {
      type: "Note",
      id: replyId,
      attributedTo: `${getSiteUrl()}/ap/actor`,
      // Federated inReplyTo must be the ORIGINAL post URL, not a synthetic boost: apId.
      inReplyTo: originalApId(inReplyTo),
      content: contentHtml,
      published: new Date().toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: ccList,
      tag: tags,
    },
  };

  // Deliver to the reply target + all followers. Resolve the target's real inbox
  // server-side (#110) — the client-sent targetInbox hardcodes Mastodon's
  // /users/<name>/inbox, which 404s to FediHome and other servers — falling back
  // to the client value only if the actor can't be resolved.
  const directInbox =
    (replyActorUri ? await resolveActorInbox(replyActorUri) : null) || targetInbox;
  if (directInbox) {
    await deliverActivity(directInbox, activity).catch(() => {});
  }
  await deliverToFollowers(activity).catch(() => {});
  // Direct-deliver to mentioned actors' inboxes
  for (const inbox of collectMentionInboxes(replyMentions)) {
    if (inbox === directInbox) continue;
    deliverActivity(inbox, activity).catch((err) =>
      console.error(`Failed to deliver mention to ${inbox}:`, err)
    );
  }

  // Store our outgoing reply so we can match incoming replies to it
  const fediHandle = siteConfig.fediHandle;
  const siteDomain = new URL(getSiteUrl()).hostname;
  await prisma.fediPost.upsert({
    where: { apId: replyId },
    create: {
      actorUri: `${getSiteUrl()}/ap/actor`,
      apId: replyId,
      content: bodyText,
      contentHtml,
      mediaUrls: [],
      mediaTypes: [],
      username: fediHandle,
      domain: siteDomain,
      displayName: siteConfig.authorName,
      avatarUrl: siteConfig.avatarPath,
      inReplyTo,
      isOutgoing: true,
      publishedAt: new Date(),
    },
    update: {},
  });

  // Optional Bluesky crosspost
  if (replyCrosspostBluesky) {
    try {
      let anchorPost: { id: string; blueskyUri: string | null } | null = null;
      let currentApId: string | null = inReplyTo;
      for (let depth = 0; depth < 8 && currentApId; depth++) {
        const localPost = await prisma.post.findUnique({
          where: { apId: currentApId },
          select: { id: true, blueskyUri: true },
        });
        if (localPost) { anchorPost = localPost; break; }
        const fediMatch = await prisma.fediPost.findUnique({
          where: { apId: currentApId },
          select: { inReplyTo: true },
        });
        currentApId = fediMatch?.inReplyTo ?? null;
      }
      const { crosspostToBluesky, crosspostReplyToBluesky } = await import("@/lib/crosspost");
      if (anchorPost?.blueskyUri) {
        await crosspostReplyToBluesky(bodyText, anchorPost.blueskyUri).catch((err: unknown) =>
          console.error("Bluesky reply crosspost failed:", err)
        );
      } else {
        await crosspostToBluesky(bodyText).catch((err: unknown) =>
          console.error("Bluesky standalone crosspost failed:", err)
        );
      }
    } catch (err) {
      console.error("Bluesky crosspost lookup failed:", err);
    }
  }

  return NextResponse.json({ success: true });
}

export async function editReply(body: AdminBody): Promise<NextResponse> {
  const { replyId: editReplyId, content: newContent } = body;
  if (!editReplyId || !newContent?.trim()) {
    return NextResponse.json({ error: "replyId and content required" }, { status: 400 });
  }

  const existingReply = await prisma.fediPost.findUnique({
    where: { id: editReplyId },
  });
  if (!existingReply || !existingReply.isOutgoing) {
    return NextResponse.json({ error: "Reply not found or not editable" }, { status: 404 });
  }

  const editMentions = await parseMentions(newContent);

  const linkedContent = newContent.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url: string) => `<a href="${url}" rel="nofollow noopener noreferrer" target="_blank">${url}</a>`
  );
  const newContentHtml = `<p>${linkMentions(linkedContent, editMentions)}</p>`;

  await prisma.fediPost.update({
    where: { id: editReplyId },
    data: { content: newContent, contentHtml: newContentHtml },
  });

  const now = new Date();
  const editMentionActors = editMentions.fedi
    .filter((m) => !!m.actorUri)
    .map((m) => m.actorUri!);
  const ccList = [`${getSiteUrl()}/ap/followers`, ...editMentionActors];
  const editTags = buildApMentionTags(editMentions);
  const updateActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${getSiteUrl()}/ap/update/reply-${existingReply.id}/${Date.now()}`,
    type: "Update",
    actor: `${getSiteUrl()}/ap/actor`,
    published: now.toISOString(),
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: ccList,
    object: {
      type: "Note",
      id: existingReply.apId,
      attributedTo: `${getSiteUrl()}/ap/actor`,
      inReplyTo: existingReply.inReplyTo,
      content: newContentHtml,
      published: existingReply.publishedAt.toISOString(),
      updated: now.toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: ccList,
      ...(editTags.length > 0 ? { tag: editTags } : {}),
    },
  };

  deliverToFollowers(updateActivity).catch((err) =>
    console.error("Failed to federate reply update:", err)
  );
  for (const inbox of collectMentionInboxes(editMentions)) {
    deliverActivity(inbox, updateActivity).catch((err) =>
      console.error(`Failed to deliver edit to mentioned ${inbox}:`, err)
    );
  }

  return NextResponse.json({ success: true, contentHtml: newContentHtml });
}

export async function backfillReplies(): Promise<NextResponse> {
  // Scan recent FediPosts (last 7 days) for replies to our content that we missed
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Gather all our AP IDs (posts, photos, and outgoing replies)
  const [ourPosts, ourPhotos, ourReplies] = await Promise.all([
    prisma.post.findMany({ where: { apId: { not: null } }, select: { apId: true } }),
    prisma.photo.findMany({ where: { apId: { not: null } }, select: { apId: true } }),
    prisma.fediPost.findMany({ where: { isOutgoing: true }, select: { apId: true } }),
  ]);
  const ourApIds = new Set([
    ...ourPosts.map((p) => p.apId).filter(Boolean),
    ...ourPhotos.map((p) => p.apId).filter(Boolean),
    ...ourReplies.map((p) => p.apId),
  ]);

  if (ourApIds.size === 0) {
    return NextResponse.json({ success: true, found: 0, message: "No outgoing content to check" });
  }

  // Find recent FediPosts that reply to one of our AP IDs but have no matching FediInteraction
  const recentReplies = await prisma.fediPost.findMany({
    where: {
      isOutgoing: false,
      inReplyTo: { in: Array.from(ourApIds) as string[] },
      publishedAt: { gte: sevenDaysAgo },
    },
  });

  let created = 0;
  for (const reply of recentReplies) {
    if (!reply.inReplyTo) continue;
    // Dedup on the reply's own apId (the FediPost.apId is the reply Note's id),
    // the same key the live inbox uses (#121) — so backfill and the inbox can't
    // double-record a reply, and distinct replies from one actor to one post
    // aren't collapsed. Fall back to the weak key only for the rare apId-less row.
    const existing = await prisma.fediInteraction.findFirst({
      where: reply.apId
        ? { sourceApId: reply.apId }
        : { actorUri: reply.actorUri, targetApId: reply.inReplyTo, type: "reply" },
    });
    if (!existing) {
      await prisma.fediInteraction.create({
        data: {
          type: "reply",
          actorUri: reply.actorUri,
          targetApId: reply.inReplyTo,
          sourceApId: reply.apId || null,
          content: reply.content,
          username: reply.username,
          domain: reply.domain,
          displayName: reply.displayName,
          avatarUrl: reply.avatarUrl,
        },
      });
      created++;
    }
  }

  return NextResponse.json({ success: true, scanned: recentReplies.length, created });
}
