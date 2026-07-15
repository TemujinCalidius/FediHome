import { NextResponse } from "next/server";
import { getBlueskyCredentials } from "@/lib/integrations";
import { prisma } from "@/lib/db";
import { deliverActivity } from "@/lib/http-signatures";
import { siteConfig } from "@/../site.config";
import { resolveBlueskyActor } from "@/lib/bluesky-graph";
import {
  resolveFediActorByHandle,
  resolveFediActorByUri,
  type ResolvedFediActor,
} from "@/lib/fedi-resolve";
import type { AdminBody } from "./types";

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

export async function fediDm(body: AdminBody): Promise<NextResponse> {
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

export async function bskyDm(body: AdminBody): Promise<NextResponse> {
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

  const creds = await getBlueskyCredentials();
  if (!creds) {
    return NextResponse.json({ error: "Bluesky not configured" }, { status: 500 });
  }
  const { handle: bskyHandle, password: bskyPassword } = creds;

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

export async function markDmRead(body: AdminBody): Promise<NextResponse> {
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

export async function markAllDmsRead(): Promise<NextResponse> {
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
