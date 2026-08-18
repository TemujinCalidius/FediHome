import { prisma } from "./db";
import { isBlueskyBlocked } from "./blocks";
import { getBlueskyAgent } from "./bluesky-agent";

/**
 * Poll Bluesky for DMs. Fetches recent conversations and stores new messages.
 */
export async function pollBlueskyDMs(): Promise<{ convos: number; messages: number }> {
  // The shared agent, so the configured PDS is honoured (#541). This used to
  // build its own against a hardcoded bsky.social.
  const agent = await getBlueskyAgent();
  if (!agent) return { convos: 0, messages: 0 };
  const myDid = agent.session!.did;

  // Chat endpoints live on a separate service; route via the proxy header.
  const chatAgent = agent.withProxy("bsky_chat", "did:web:api.bsky.chat");

  // List recent conversations
  const convosRes = await chatAgent.api.chat.bsky.convo.listConvos({ limit: 20 });
  if (!convosRes.success) return { convos: 0, messages: 0 };

  let totalMessages = 0;

  for (const convo of convosRes.data.convos) {
    // Get messages in this conversation
    const messagesRes = await chatAgent.api.chat.bsky.convo.getMessages({
      convoId: convo.id,
      limit: 30,
    });

    if (!messagesRes.success) continue;

    for (const msg of messagesRes.data.messages) {
      if (msg.$type !== "chat.bsky.convo.defs#messageView") continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = msg as any;
      const msgId = message.id;
      const senderDid = message.sender?.did;
      const text = message.text || "";
      const sentAt = message.sentAt ? new Date(message.sentAt) : new Date();

      if (!msgId || !text) continue;

      // Determine if this is outgoing (from us)
      const isOutgoing = senderDid === myDid;

      // Get sender info from convo members
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const members = convo.members as any[];
      const sender = members?.find((m: { did: string }) => m.did === senderDid);
      const senderHandle = sender?.handle || senderDid || "unknown";
      const senderName = sender?.displayName || null;
      const senderAvatar = sender?.avatar || null;

      // THE ONE UNGATED INGEST (#564). The fediverse side refuses a blocked
      // sender at the top of the inbox route, so nothing is ever stored. Bluesky
      // DM polling had no block check anywhere in this file, which is why
      // blocked Bluesky accounts kept arriving at all.
      //
      // Both halves, per #563: the DID alone would skip the domain query and a
      // `spam.example` block would not cover `alice.spam.example`. Incoming
      // only — our own sent messages are ours regardless of who we later block.
      if (!isOutgoing && (await isBlueskyBlocked({ did: senderDid || "", handle: senderHandle }))) {
        continue;
      }

      try {
        await prisma.directMessage.upsert({
          where: { bskyMessageId: msgId },
          create: {
            source: "bluesky",
            senderUri: senderDid || "",
            senderHandle,
            senderName,
            senderAvatar,
            content: text,
            bskyConvoId: convo.id,
            bskyMessageId: msgId,
            conversationKey: `bsky:${convo.id}`,
            isOutgoing,
            createdAt: sentAt,
          },
          update: {
            content: text,
            senderName,
            senderAvatar,
          },
        });
        totalMessages++;
      } catch {
        // Skip duplicates
      }
    }
  }

  return { convos: convosRes.data.convos.length, messages: totalMessages };
}
