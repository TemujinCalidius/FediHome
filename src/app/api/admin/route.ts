import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverActivity, deliverToFollowers } from "@/lib/http-signatures";
import { processAttachments, fetchLinkEmbed } from "@/lib/fedi-media";
import { assertPublicHost, isPrivateUrl } from "@/lib/url-guard";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { sanitizeHtml } from "@/lib/sanitize";
import { siteConfig } from "@/../site.config";
import { parseMentions, linkMentions, buildApMentionTags, collectMentionInboxes } from "@/lib/mentions";
import {
  syncBlueskyGraph,
  followBlueskyAccount,
  unfollowBlueskyAccount,
  resolveBlueskyActor,
} from "@/lib/bluesky-graph";
import {
  resolveFediActorByHandle,
  resolveFediActorByUri,
  type ResolvedFediActor,
} from "@/lib/fedi-resolve";

/**
 * Resolve a Fedi recipient to their actorUri + inbox. Prefer cached records
 * (FediFollower / FediFollowing) — they're already vetted and avoid an extra
 * webfinger / actor fetch. Fall back to live resolution when needed.
 */
async function resolveFediRecipient(opts: {
  recipientUri?: string;
  recipientInbox?: string;
  recipientHandle?: string;
}): Promise<ResolvedFediActor | null> {
  const { recipientUri, recipientInbox, recipientHandle } = opts;

  if (recipientUri) {
    const cachedFollower = await prisma.fediFollower.findUnique({
      where: { actorUri: recipientUri },
    });
    if (cachedFollower) {
      return {
        actorUri: cachedFollower.actorUri,
        inbox: recipientInbox || cachedFollower.inbox,
        sharedInbox: cachedFollower.sharedInbox || null,
        username: cachedFollower.username,
        domain: cachedFollower.domain,
        displayName: cachedFollower.displayName,
        avatarUrl: cachedFollower.avatarUrl,
      };
    }
    const cachedFollowing = await prisma.fediFollowing.findUnique({
      where: { actorUri: recipientUri },
    });
    if (cachedFollowing) {
      return {
        actorUri: cachedFollowing.actorUri,
        inbox: recipientInbox || cachedFollowing.inbox,
        sharedInbox: null,
        username: cachedFollowing.username,
        domain: cachedFollowing.domain,
        displayName: cachedFollowing.displayName,
        avatarUrl: cachedFollowing.avatarUrl,
      };
    }
    // Unknown URI — try live actor fetch.
    return await resolveFediActorByUri(recipientUri);
  }

  if (recipientHandle) {
    return await resolveFediActorByHandle(recipientHandle);
  }

  return null;
}

/**
 * Build + deliver a private ActivityPub Note. Returns the stored DirectMessage
 * row (with deliveredAt / deliveryError populated) so the route can echo it.
 * Shared by `dm_reply` and `dm_new_fedi`.
 */
async function sendFediDm(
  content: string,
  recipient: ResolvedFediActor
): Promise<{ id: string; deliveredAt: Date | null; deliveryError: string | null }> {
  const dmNoteId = `${siteConfig.url}/ap/dm/${Date.now()}`;
  const dmActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${siteConfig.url}/ap/create/dm-${Date.now()}`,
    type: "Create",
    actor: `${siteConfig.url}/ap/actor`,
    published: new Date().toISOString(),
    object: {
      type: "Note",
      id: dmNoteId,
      attributedTo: `${siteConfig.url}/ap/actor`,
      content: `<p>${content}</p>`,
      published: new Date().toISOString(),
      to: [recipient.actorUri],
    },
  };

  const result = await deliverActivity(recipient.inbox, dmActivity);

  const stored = await prisma.directMessage.create({
    data: {
      source: "fedi",
      senderUri: `${siteConfig.url}/ap/actor`,
      senderHandle: siteConfig.fediAddress,
      senderName: siteConfig.authorName,
      content,
      contentHtml: `<p>${content}</p>`,
      apId: dmNoteId,
      conversationKey: `fedi:${recipient.actorUri}`,
      isOutgoing: true,
      createdAt: new Date(),
      deliveredAt: result.ok ? new Date() : null,
      deliveryError: result.ok ? null : (result.error || `status ${result.status}`),
    },
  });

  return {
    id: stored.id,
    deliveredAt: stored.deliveredAt,
    deliveryError: stored.deliveryError,
  };
}

const REMOTE_FETCH_TIMEOUT_MS = 8000;

const siteUrl = siteConfig.url;

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { action } = body;

  switch (action) {
    case "approve_comment": {
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
        const noteId = `${siteUrl}/ap/comment/${comment.id}`;
        // H3: HTML-escape guest-supplied content before embedding it in the
        // federated Note. Receivers re-sanitize, but unsanitized HTML on the
        // wire is still a stored-XSS waiting to happen on small fedi servers
        // and on our own site if rendering paths change.
        const escape = (s: string) =>
          s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const noteContent = `<p><strong>${escape(comment.guestName)}</strong> (via ${escape(new URL(siteUrl).hostname)}):</p><p>${escape(comment.content)}</p>`;

        const activity = {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${siteUrl}/ap/create/${comment.id}`,
          type: "Create",
          actor: `${siteUrl}/ap/actor`,
          published: new Date().toISOString(),
          object: {
            type: "Note",
            id: noteId,
            attributedTo: `${siteUrl}/ap/actor`,
            inReplyTo: targetApId,
            content: noteContent,
            published: new Date().toISOString(),
            to: ["https://www.w3.org/ns/activitystreams#Public"],
            cc: [`${siteUrl}/ap/followers`],
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

    case "reply": {
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

      const replyId = `${siteUrl}/ap/reply/${Date.now()}`;
      const ccList = [`${siteUrl}/ap/followers`];
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
        id: `${siteUrl}/ap/create/reply-${Date.now()}`,
        type: "Create",
        actor: `${siteUrl}/ap/actor`,
        published: new Date().toISOString(),
        object: {
          type: "Note",
          id: replyId,
          attributedTo: `${siteUrl}/ap/actor`,
          inReplyTo,
          content: contentHtml,
          published: new Date().toISOString(),
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: ccList,
          tag: tags,
        },
      };

      // Deliver to the specific inbox + all followers
      if (targetInbox) {
        await deliverActivity(targetInbox, activity).catch(() => {});
      }
      await deliverToFollowers(activity).catch(() => {});
      // Direct-deliver to mentioned actors' inboxes
      for (const inbox of collectMentionInboxes(replyMentions)) {
        if (inbox === targetInbox) continue;
        deliverActivity(inbox, activity).catch((err) =>
          console.error(`Failed to deliver mention to ${inbox}:`, err)
        );
      }

      // Store our outgoing reply so we can match incoming replies to it
      const fediHandle = siteConfig.fediHandle;
      const siteDomain = new URL(siteUrl).hostname;
      await prisma.fediPost.upsert({
        where: { apId: replyId },
        create: {
          actorUri: `${siteUrl}/ap/actor`,
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

    case "edit_reply": {
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
      const ccList = [`${siteUrl}/ap/followers`, ...editMentionActors];
      const editTags = buildApMentionTags(editMentions);
      const updateActivity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${siteUrl}/ap/update/reply-${existingReply.id}/${Date.now()}`,
        type: "Update",
        actor: `${siteUrl}/ap/actor`,
        published: now.toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: ccList,
        object: {
          type: "Note",
          id: existingReply.apId,
          attributedTo: `${siteUrl}/ap/actor`,
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

    case "dm_reply":
    case "dm_new_fedi": {
      // dm_reply: continue an existing fedi conversation (recipientUri known).
      // dm_new_fedi: start a new conversation; takes either recipientUri (from
      // followers/following picker) or recipientHandle (free-text @user@domain).
      const {
        content: dmContent,
        recipientUri,
        recipientInbox,
        recipientHandle,
      } = body;
      if (!dmContent || (!recipientUri && !recipientHandle)) {
        return NextResponse.json(
          { error: "content and recipientUri or recipientHandle required" },
          { status: 400 }
        );
      }

      const recipient = await resolveFediRecipient({
        recipientUri,
        recipientInbox,
        recipientHandle,
      });
      if (!recipient) {
        return NextResponse.json(
          { error: "Could not resolve recipient (handle invalid or actor unreachable)" },
          { status: 400 }
        );
      }

      const sent = await sendFediDm(dmContent, recipient);

      return NextResponse.json({
        success: true,
        delivered: sent.deliveredAt !== null,
        deliveryError: sent.deliveryError,
        recipient: {
          actorUri: recipient.actorUri,
          handle: `@${recipient.username}@${recipient.domain}`,
          displayName: recipient.displayName,
          avatarUrl: recipient.avatarUrl,
        },
      });
    }

    case "bsky_dm_reply":
    case "bsky_dm_new": {
      // bsky_dm_reply: convoId already known.
      // bsky_dm_new: takes recipientDid OR recipientHandle, calls
      //              chat.bsky.convo.getConvoForMembers to start/find the convo.
      const {
        content: bskyDmContent,
        convoId: existingConvoId,
        recipientDid,
        recipientHandle,
      } = body;
      if (!bskyDmContent || (!existingConvoId && !recipientDid && !recipientHandle)) {
        return NextResponse.json(
          { error: "content and convoId or recipient required" },
          { status: 400 }
        );
      }

      const bskyHandle = process.env.BLUESKY_HANDLE;
      const bskyPassword = process.env.BLUESKY_APP_PASSWORD;
      if (!bskyHandle || !bskyPassword) {
        return NextResponse.json({ error: "Bluesky not configured" }, { status: 500 });
      }

      try {
        const { BskyAgent } = await import("@atproto/api");
        const agent = new BskyAgent({ service: "https://bsky.social" });
        await agent.login({ identifier: bskyHandle, password: bskyPassword });
        const chatAgent = agent.withProxy("bsky_chat", "did:web:api.bsky.chat");

        let convoId = existingConvoId as string | undefined;
        if (!convoId) {
          const did = recipientDid || (await resolveBlueskyActor(recipientHandle));
          const convoRes = await chatAgent.api.chat.bsky.convo.getConvoForMembers({
            members: [did],
          });
          convoId = convoRes.data.convo.id;
        }

        const sendRes = await chatAgent.api.chat.bsky.convo.sendMessage({
          convoId,
          message: { text: bskyDmContent },
        });

        await prisma.directMessage.create({
          data: {
            source: "bluesky",
            senderUri: agent.session!.did,
            senderHandle: bskyHandle,
            senderName: siteConfig.authorName,
            content: bskyDmContent,
            bskyConvoId: convoId,
            bskyMessageId: sendRes.data.id,
            conversationKey: `bsky:${convoId}`,
            isOutgoing: true,
            createdAt: new Date(),
            // Bluesky API call returning success = message accepted by their service.
            deliveredAt: new Date(),
          },
        });

        return NextResponse.json({ success: true, delivered: true, convoId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Bluesky DM failed";
        console.error("Bluesky DM failed:", err);
        return NextResponse.json(
          { error: "Bluesky DM failed", detail: msg.slice(0, 200) },
          { status: 500 }
        );
      }
    }

    case "mark_dm_read": {
      // Mark a single conversation read up to now. conversationKey matches the
      // server-stored DirectMessage.conversationKey ("fedi:{uri}" or "bsky:{convoId}").
      const { conversationKey } = body;
      if (!conversationKey || typeof conversationKey !== "string") {
        return NextResponse.json({ error: "conversationKey required" }, { status: 400 });
      }
      const now = new Date();
      await prisma.dmConversationRead.upsert({
        where: { conversationKey },
        create: { conversationKey, lastReadAt: now },
        update: { lastReadAt: now },
      });
      return NextResponse.json({ success: true, lastReadAt: now.toISOString() });
    }

    case "mark_all_dms_read": {
      // Bulk-mark every conversation that has at least one stored message.
      const now = new Date();
      const keys = await prisma.directMessage.findMany({
        select: { conversationKey: true },
        distinct: ["conversationKey"],
      });
      await prisma.$transaction(
        keys.map((k) =>
          prisma.dmConversationRead.upsert({
            where: { conversationKey: k.conversationKey },
            create: { conversationKey: k.conversationKey, lastReadAt: now },
            update: { lastReadAt: now },
          })
        )
      );
      return NextResponse.json({ success: true, count: keys.length, lastReadAt: now.toISOString() });
    }

    case "bsky_reply": {
      const { content: bskyReplyContent, blueskyUri: parentUri, crosspostFedi } = body;
      if (!bskyReplyContent || !parentUri) {
        return NextResponse.json({ error: "content and blueskyUri required" }, { status: 400 });
      }
      const bskyHandle = process.env.BLUESKY_HANDLE;
      const bskyPassword = process.env.BLUESKY_APP_PASSWORD;
      if (!bskyHandle || !bskyPassword) {
        return NextResponse.json({ error: "Bluesky not configured" }, { status: 500 });
      }
      try {
        const { BskyAgent } = await import("@atproto/api");
        const agent = new BskyAgent({ service: "https://bsky.social" });
        await agent.login({ identifier: bskyHandle, password: bskyPassword });
        const uriParts = parentUri.replace("at://", "").split("/");
        const repo = uriParts[0];
        const rkey = uriParts[uriParts.length - 1];
        const parentPost = await agent.getPost({ repo, rkey }) as { uri: string; cid: string; value: Record<string, unknown> };
        const parentCid = parentPost.cid;
        const parentReplyRef = parentPost.value.reply as { root: { uri: string; cid: string } } | undefined;
        const rootRef = parentReplyRef
          ? { uri: parentReplyRef.root.uri, cid: parentReplyRef.root.cid }
          : { uri: parentUri, cid: parentCid };
        await agent.post({
          text: bskyReplyContent,
          reply: { root: rootRef, parent: { uri: parentUri, cid: parentCid } },
        });

        // Optional Fediverse crosspost — federates as a fedi Note
        if (crosspostFedi) {
          try {
            const localPostFromBsky = await prisma.post.findFirst({
              where: { blueskyUri: parentUri },
              select: { apId: true },
            });
            const linkedContent = bskyReplyContent.replace(
              /(https?:\/\/[^\s<]+)/g,
              (url: string) => `<a href="${url}" rel="nofollow noopener noreferrer" target="_blank">${url}</a>`
            );
            const fediHtml = `<p>${linkedContent}</p>`;
            const fediReplyId = `${siteUrl}/ap/reply/${Date.now()}`;
            const fediActivity = {
              "@context": "https://www.w3.org/ns/activitystreams",
              id: `${siteUrl}/ap/create/bsky-reply-${Date.now()}`,
              type: "Create",
              actor: `${siteUrl}/ap/actor`,
              published: new Date().toISOString(),
              object: {
                type: "Note",
                id: fediReplyId,
                attributedTo: `${siteUrl}/ap/actor`,
                content: fediHtml,
                published: new Date().toISOString(),
                to: ["https://www.w3.org/ns/activitystreams#Public"],
                cc: [`${siteUrl}/ap/followers`],
                ...(localPostFromBsky?.apId ? { inReplyTo: localPostFromBsky.apId } : {}),
              },
            };
            deliverToFollowers(fediActivity).catch((err) =>
              console.error("Fedi crosspost from bsky_reply failed:", err)
            );
            const fediHandle = siteConfig.fediHandle;
            const siteDomain = new URL(siteUrl).hostname;
            await prisma.fediPost.upsert({
              where: { apId: fediReplyId },
              create: {
                actorUri: `${siteUrl}/ap/actor`,
                apId: fediReplyId,
                content: bskyReplyContent,
                contentHtml: fediHtml,
                mediaUrls: [],
                mediaTypes: [],
                username: fediHandle,
                domain: siteDomain,
                displayName: siteConfig.authorName,
                avatarUrl: siteConfig.avatarPath,
                inReplyTo: localPostFromBsky?.apId ?? null,
                isOutgoing: true,
                publishedAt: new Date(),
              },
              update: {},
            });
          } catch (err) {
            console.error("Fedi crosspost from bsky_reply prep failed:", err);
          }
        }

        return NextResponse.json({ success: true });
      } catch (err) {
        console.error("Bluesky reply failed:", err);
        return NextResponse.json({ error: "Bluesky reply failed" }, { status: 500 });
      }
    }

    case "reject_comment": {
      const { commentId } = body;
      await prisma.guestComment.update({
        where: { id: commentId },
        data: { status: "rejected" },
      });
      return NextResponse.json({ success: true });
    }

    case "follow": {
      const { handle } = body;
      // Parse handle: @user@domain or user@domain
      const cleaned = handle.replace(/^@/, "");
      const [username, domain] = cleaned.split("@");

      if (!username || !domain) {
        return NextResponse.json(
          { error: "Invalid handle format. Use @user@domain" },
          { status: 400 }
        );
      }

      // Discover actor via WebFinger
      try {
        // Validate domain — same character set we'd accept from a Mastodon handle.
        if (!/^[a-z0-9.-]+$/i.test(domain) || domain.includes("..")) {
          throw new Error("invalid domain");
        }
        const wfUrl = `https://${domain}/.well-known/webfinger?resource=acct:${encodeURIComponent(username)}@${encodeURIComponent(domain)}`;
        if (isPrivateUrl(wfUrl)) throw new Error("blocked: private host");
        const wfRes = await fetch(wfUrl, {
          headers: { Accept: "application/jrd+json" },
          signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
        });
        if (!wfRes.ok) throw new Error("WebFinger failed");

        const wfData = await wfRes.json();
        const actorLink = wfData.links?.find(
          (l: { rel: string; type?: string }) =>
            l.rel === "self" && l.type === "application/activity+json"
        );

        if (!actorLink?.href) throw new Error("No actor link found");
        // H8: a malicious WebFinger response could point us at internal services.
        // Use assertPublicHost (DNS-resolves) so a rebinding hostname is caught.
        if (!(await assertPublicHost(actorLink.href))) {
          throw new Error("blocked: actor URL resolves to private host");
        }

        // Fetch actor profile
        const actorRes = await fetch(actorLink.href, {
          headers: { Accept: "application/activity+json" },
          signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
        });
        if (!actorRes.ok) throw new Error("Actor fetch failed");

        const actor = await actorRes.json();
        // H8: the actor's own claimed inbox/outbox could point at internal services.
        if (typeof actor.inbox !== "string" || !(await assertPublicHost(actor.inbox))) {
          throw new Error("blocked: actor inbox resolves to private host");
        }
        if (actor.outbox && (typeof actor.outbox !== "string" || !(await assertPublicHost(actor.outbox)))) {
          throw new Error("blocked: actor outbox resolves to private host");
        }

        // Store following record
        await prisma.fediFollowing.upsert({
          where: { actorUri: actorLink.href },
          create: {
            actorUri: actorLink.href,
            inbox: actor.inbox,
            username: actor.preferredUsername || username,
            domain,
            displayName: actor.name || null,
            avatarUrl: actor.icon?.url || null,
          },
          update: {
            displayName: actor.name || null,
            avatarUrl: actor.icon?.url || null,
          },
        });

        // Pull recent posts from their outbox
        if (actor.outbox) {
          try {
            const outboxRes = await fetch(actor.outbox, {
              headers: { Accept: "application/activity+json" },
              signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
            });
            if (outboxRes.ok) {
              const outbox = await outboxRes.json();
              const items = outbox.orderedItems || outbox.items || [];
              for (const item of items.slice(0, 10)) {
                const note = item.type === "Create" ? item.object : item;
                if (!note?.id || !note?.content) continue;

                const { urls: mediaUrls, types: mediaTypes } =
                  await processAttachments(note.attachment);
                const safeContent = sanitizeHtml(note.content || "");
                const embed = await fetchLinkEmbed(safeContent);
                const inReplyTo = (note.inReplyTo as string) || null;
                const conversationId =
                  note.conversation || note.context || inReplyTo || note.id || null;

                await prisma.fediPost.upsert({
                  where: { apId: note.id },
                  create: {
                    actorUri: actorLink.href,
                    apId: note.id,
                    content: safeContent,
                    contentHtml: safeContent,
                    mediaUrls,
                    mediaTypes,
                    inReplyTo,
                    conversationId,
                    embedUrl: embed?.url || null,
                    embedTitle: embed?.title || null,
                    embedDescription: embed?.description || null,
                    embedImage: embed?.image || null,
                    embedSiteName: embed?.siteName || null,
                    username: actor.preferredUsername || username,
                    domain,
                    displayName: actor.name || null,
                    avatarUrl: actor.icon?.url || null,
                    publishedAt: note.published ? new Date(note.published) : new Date(),
                  },
                  update: {},
                });
              }
            }
          } catch (err) {
            console.error("Failed to fetch outbox:", err);
          }
        }

        // Send signed Follow activity
        await deliverActivity(actor.inbox, {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${siteUrl}/ap/follow/${Date.now()}`,
          type: "Follow",
          actor: `${siteUrl}/ap/actor`,
          object: actorLink.href,
        });

        return NextResponse.json({ success: true });
      } catch (err) {
        return NextResponse.json(
          { error: `Failed to follow: ${err}` },
          { status: 400 }
        );
      }
    }

    case "unfollow": {
      const { followingId } = body;
      const record = await prisma.fediFollowing.findUnique({
        where: { id: followingId },
      });

      if (record) {
        // Send signed Undo Follow
        try {
          await deliverActivity(record.inbox, {
            "@context": "https://www.w3.org/ns/activitystreams",
            id: `${siteUrl}/ap/undo/${Date.now()}`,
            type: "Undo",
            actor: `${siteUrl}/ap/actor`,
            object: {
              type: "Follow",
              actor: `${siteUrl}/ap/actor`,
              object: record.actorUri,
            },
          });
        } catch {
          // Continue even if undo delivery fails
        }

        await prisma.fediFollowing.delete({ where: { id: followingId } });
      }

      return NextResponse.json({ success: true });
    }

    case "unfollow_by_uri": {
      const { actorUri: unfollowUri } = body;
      if (!unfollowUri) {
        return NextResponse.json({ error: "actorUri required" }, { status: 400 });
      }
      const record = await prisma.fediFollowing.findUnique({ where: { actorUri: unfollowUri } });
      if (record) {
        try {
          await deliverActivity(record.inbox, {
            "@context": "https://www.w3.org/ns/activitystreams",
            id: `${siteUrl}/ap/undo/${Date.now()}`,
            type: "Undo",
            actor: `${siteUrl}/ap/actor`,
            object: {
              type: "Follow",
              actor: `${siteUrl}/ap/actor`,
              object: unfollowUri,
            },
          });
        } catch {
          // Continue
        }
        await prisma.fediFollowing.delete({ where: { actorUri: unfollowUri } });
      }
      return NextResponse.json({ success: true });
    }

    case "like": {
      // Like a fedi post
      const { postApId, targetInbox: likeInbox } = body;
      if (!postApId) {
        return NextResponse.json({ error: "postApId required" }, { status: 400 });
      }

      const likeActivity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${siteUrl}/ap/like/${Date.now()}`,
        type: "Like",
        actor: `${siteUrl}/ap/actor`,
        object: postApId,
      };

      if (likeInbox) {
        await deliverActivity(likeInbox, likeActivity).catch(() => {});
      }
      await deliverToFollowers(likeActivity).catch(() => {});

      // Remember we liked it so the button stays lit after a reload.
      await prisma.fediPost.updateMany({ where: { apId: postApId }, data: { likedByMe: true } });

      return NextResponse.json({ success: true });
    }

    case "boost": {
      // Boost/announce a fedi post
      const { postApId: boostApId, targetInbox: boostInbox } = body;
      if (!boostApId) {
        return NextResponse.json({ error: "postApId required" }, { status: 400 });
      }

      const announceActivity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${siteUrl}/ap/announce/${Date.now()}`,
        type: "Announce",
        actor: `${siteUrl}/ap/actor`,
        object: boostApId,
        published: new Date().toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [`${siteUrl}/ap/followers`],
      };

      if (boostInbox) {
        await deliverActivity(boostInbox, announceActivity).catch(() => {});
      }
      await deliverToFollowers(announceActivity).catch(() => {});

      // Remember we boosted it so the button stays lit after a reload.
      await prisma.fediPost.updateMany({ where: { apId: boostApId }, data: { boostedByMe: true } });

      return NextResponse.json({ success: true });
    }

    case "block": {
      // Block a fedi user — unfollow, remove their posts, prevent future content
      const { actorUri } = body;
      if (!actorUri) {
        return NextResponse.json({ error: "actorUri required" }, { status: 400 });
      }

      // Unfollow if following
      const followRecord = await prisma.fediFollowing.findUnique({
        where: { actorUri },
      });
      if (followRecord) {
        try {
          await deliverActivity(followRecord.inbox, {
            "@context": "https://www.w3.org/ns/activitystreams",
            id: `${siteUrl}/ap/undo/${Date.now()}`,
            type: "Undo",
            actor: `${siteUrl}/ap/actor`,
            object: {
              type: "Follow",
              actor: `${siteUrl}/ap/actor`,
              object: actorUri,
            },
          });
        } catch {
          // Continue even if delivery fails
        }
        await prisma.fediFollowing.delete({ where: { actorUri } });
      }

      // Send Block activity
      const follower = await prisma.fediFollower.findUnique({ where: { actorUri } });
      if (follower) {
        try {
          await deliverActivity(follower.inbox, {
            "@context": "https://www.w3.org/ns/activitystreams",
            id: `${siteUrl}/ap/block/${Date.now()}`,
            type: "Block",
            actor: `${siteUrl}/ap/actor`,
            object: actorUri,
          });
        } catch {
          // Continue
        }
        await prisma.fediFollower.delete({ where: { actorUri } });
      }

      // Delete all their posts from our timeline
      await prisma.fediPost.deleteMany({ where: { actorUri } });

      // Delete their interactions
      await prisma.fediInteraction.deleteMany({ where: { actorUri } });

      return NextResponse.json({ success: true });
    }

    case "backfill_replies": {
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
        // Check if we already have this interaction
        const existing = await prisma.fediInteraction.findFirst({
          where: { actorUri: reply.actorUri, targetApId: reply.inReplyTo, type: "reply" },
        });
        if (!existing) {
          await prisma.fediInteraction.create({
            data: {
              type: "reply",
              actorUri: reply.actorUri,
              targetApId: reply.inReplyTo,
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

    case "sync_bluesky_graph": {
      try {
        const counts = await syncBlueskyGraph();
        return NextResponse.json({ success: true, ...counts });
      } catch (err) {
        console.error("Bluesky graph sync failed:", err);
        return NextResponse.json({ error: "Bluesky graph sync failed" }, { status: 500 });
      }
    }

    case "bsky_follow": {
      const { did, handleOrDid } = body;
      try {
        const targetDid = did || (handleOrDid ? await resolveBlueskyActor(handleOrDid) : null);
        if (!targetDid) {
          return NextResponse.json({ error: "did or handleOrDid required" }, { status: 400 });
        }
        await followBlueskyAccount(targetDid);
        return NextResponse.json({ success: true });
      } catch (err) {
        console.error("Bluesky follow failed:", err);
        return NextResponse.json({ error: `Bluesky follow failed: ${err}` }, { status: 500 });
      }
    }

    case "bsky_unfollow": {
      const { followingId } = body;
      if (!followingId) {
        return NextResponse.json({ error: "followingId required" }, { status: 400 });
      }
      try {
        await unfollowBlueskyAccount(followingId);
        return NextResponse.json({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("Missing followUri") ? 422 : 500;
        console.error("Bluesky unfollow failed:", err);
        return NextResponse.json({ error: message }, { status });
      }
    }

    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
