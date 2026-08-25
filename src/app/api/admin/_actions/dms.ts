import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { blockedDmSenderUris, blockedBlueskyAccount } from "@/lib/blocks";
import { deliverActivity } from "@/lib/http-signatures";
import { siteConfig } from "@/../site.config";
import { resolveBlueskyActor } from "@/lib/bluesky-graph";
import {
  resolveFediActorByHandle,
  resolveFediActorByUri,
  type ResolvedFediActor,
} from "@/lib/fedi-resolve";
import type { AdminBody } from "./types";
import { getBlueskyAgent } from "@/lib/bluesky-agent";

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

  const result = await deliverActivity(recipient.inbox, dmActivity, { actorUri: recipient.actorUri });

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

/**
 * Everyone in a Bluesky conversation, for the outbound block gate (#577).
 *
 * Asks the chat service first, because `convo.members` is the only source that
 * names EVERY participant — the DirectMessage rows we store name only people
 * who have written to us, so a group chat where the blocked member has been
 * quiet would pass a check built on them alone.
 *
 * Falls back to those stored rows when the call fails, and returns `null` when
 * neither can answer. `null` means "unknown", and the caller refuses on it: a
 * DM is not urgent enough to send to someone we cannot identify.
 */
async function convoMembers(
  chatAgent: { api: { chat: { bsky: { convo: { getConvo: (p: { convoId: string }) => Promise<{ data: { convo: { members?: { did: string; handle?: string }[] } } }> } } } } },
  convoId: string,
): Promise<{ did: string; handle: string | null }[] | null> {
  try {
    const res = await chatAgent.api.chat.bsky.convo.getConvo({ convoId });
    const members = res.data.convo.members ?? [];
    if (members.length > 0) {
      return members.map((m) => ({ did: m.did, handle: m.handle ?? null }));
    }
  } catch (err) {
    console.error("Couldn't read Bluesky convo members for the block check:", err);
  }
  try {
    const rows = await prisma.directMessage.findMany({
      where: { bskyConvoId: convoId, isOutgoing: false },
      select: { senderUri: true, senderHandle: true },
      distinct: ["senderUri"],
    });
    if (rows.length === 0) return null;
    return rows.map((r) => ({
      did: r.senderUri,
      // Only a real handle carries a domain; ingest stores a DID here when the
      // convo member list didn't name the sender.
      handle: r.senderHandle?.includes(".") ? r.senderHandle : null,
    }));
  } catch {
    return null;
  }
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

  // THE DOMAIN HALF, BEFORE WE RESOLVE ANYTHING (#577). Resolving a handle can
  // touch the other side's own domain — `alice.spam.example` is resolved via
  // spam.example — so a domain block has to be answered before that, not after.
  // A blank DID is fine here: the actor lookup simply misses and the domain
  // query does the work.
  if (recipientHandle && (await blockedBlueskyAccount("", recipientHandle))) {
    return NextResponse.json({ error: "recipient is blocked" }, { status: 409 });
  }

  // The shared agent, so the configured PDS is honoured (#541). This used to
  // build its own against a hardcoded bsky.social.
  const agent = await getBlueskyAgent();
  if (!agent) {
    return NextResponse.json({ error: "Bluesky not configured" }, { status: 500 });
  }

  try {
    const chatAgent = agent.withProxy("bsky_chat", "did:web:api.bsky.chat");

    let convoId = existingConvoId as string | undefined;
    if (!convoId) {
      const did = recipientDid || (await resolveBlueskyActor(recipientHandle));
      // BEFORE getConvoForMembers, which is itself contact — it creates the
      // conversation on their side. #379's guarantee is zero contact, not a
      // request we decline to follow up.
      if (await blockedBlueskyAccount(did, recipientHandle ?? null)) {
        return NextResponse.json({ error: "recipient is blocked" }, { status: 409 });
      }
      const convoRes = await chatAgent.api.chat.bsky.convo.getConvoForMembers({
        members: [did],
      });
      convoId = convoRes.data.convo.id;
    } else {
      // A REPLY KNOWS ONLY A CONVO ID, so the members have to be recovered.
      // `getConvo` is asked first and the stored messages are the fallback:
      // a convo can hold more than two people, and a stored row only ever names
      // the last person who wrote to us — checking that alone would let a reply
      // reach a blocked third member of a group chat. Both routes stay local to
      // our own chat service; neither touches the blocked account.
      const members = await convoMembers(chatAgent, convoId);
      if (members === null) {
        return NextResponse.json(
          { error: "Couldn't verify who this conversation is with — try again" },
          { status: 502 },
        );
      }
      const myDid = agent.session?.did;
      for (const m of members) {
        if (m.did === myDid) continue;
        if (await blockedBlueskyAccount(m.did, m.handle)) {
          return NextResponse.json({ error: "recipient is blocked" }, { status: 409 });
        }
      }
    }

    const sendRes = await chatAgent.api.chat.bsky.convo.sendMessage({
      convoId,
      message: { text: bskyDmContent },
    });

    await prisma.directMessage.create({
      data: {
        source: "bluesky",
        senderUri: agent.session!.did,
        // From the SESSION, not the stored credential (#541). The line above
        // already reads the DID this way, and the handle is the mutable half —
        // after a domain-handle claim (#448) the saved one goes stale while the
        // session carries what the PDS actually authenticated us as.
        senderHandle: agent.session!.handle,
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
  // Filtered too (#564), though nothing here is rendered. Without it this writes
  // DmConversationRead rows for conversations the owner cannot see, and reports
  // a `count` that includes them — a number that silently disagrees with the
  // list it claims to describe.
  const blockedDmUris = await blockedDmSenderUris();
  const keys = await prisma.directMessage.findMany({
    where: blockedDmUris.length ? { NOT: { senderUri: { in: blockedDmUris } } } : {},
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
