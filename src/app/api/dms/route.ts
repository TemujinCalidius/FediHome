import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";
import { sanitizeHtml } from "@/lib/sanitize";
import { blockedDmSenderUris } from "@/lib/blocks";

const MAX_MESSAGES = 200;

/**
 * Direct messages + per-conversation read state, in the shape the timeline uses.
 *
 * Gated on the dedicated `dm` scope (NOT `read`) — messages are private, so an
 * app granted only feed access must not read them. The owner cookie satisfies it
 * (full rights). GET is read-only → no CSRF. contentHtml is re-sanitized on emit.
 */
export async function GET(req: NextRequest) {
  if (!(await authenticateApiRequest(req, "dm")).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Resolved BEFORE the query, not applied after it (#564). These reads cap at
  // MAX_MESSAGES, so filtering the returned page would silently shrink it and
  // drop legitimate messages that fell off the end.
  //
  // Must stay identical to the SSR read in timeline/page.tsx: that pair
  // disagreeing is the #459 failure, where the first paint hid a blocked
  // account and every client refetch brought it back.
  const blockedDmUris = await blockedDmSenderUris();
  const [messagesRaw, readRows] = await Promise.all([
    prisma.directMessage.findMany({
      where: blockedDmUris.length ? { NOT: { senderUri: { in: blockedDmUris } } } : {},
      orderBy: { createdAt: "desc" },
      take: MAX_MESSAGES,
    }),
    prisma.dmConversationRead.findMany(),
  ]);

  const messages = messagesRaw.map((m) => ({
    ...m,
    contentHtml: m.contentHtml ? sanitizeHtml(m.contentHtml) : null,
  }));

  const readState: Record<string, string> = {};
  for (const row of readRows) {
    readState[row.conversationKey] = row.lastReadAt.toISOString();
  }

  return NextResponse.json({
    messages: JSON.parse(JSON.stringify(messages)),
    readState,
  });
}
