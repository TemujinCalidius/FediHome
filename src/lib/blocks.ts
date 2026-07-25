import { prisma } from "./db";

/**
 * Block enforcement for incoming federated activity.
 *
 * **The bug this fixes.** `block()` (admin `_actions/fedi-graph.ts`) removed the
 * follow relationship and purged the actor's cached posts and interactions — but
 * nothing ever consulted `BlockedActor` again. A blocked account could re-follow,
 * re-like and reply the very next second, and it was stored and push-notified as
 * normal. Block was a one-shot purge, not a block.
 *
 * **Deliberately local.** ActivityPub says a server SHOULD NOT deliver `Block`
 * activities to the actor being blocked, precisely so the blocked person can't
 * tell. We follow that: enforcement happens entirely on our side, and a blocked
 * sender gets exactly the same `202 Accepted` as everyone else. Their server
 * sees a normal delivery; nothing signals the block.
 */

/** Lowercased host of an actor URI, or `null` if it isn't a usable URL. */
export function actorHost(actorUri: string): string | null {
  try {
    return new URL(actorUri).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether an incoming activity from this actor should be dropped.
 *
 * Fails **open** on a database error: an inbox that rejects everything because
 * the DB hiccuped is a worse failure than briefly honouring one activity from a
 * blocked actor. Blocking is a preference, not a security boundary — signature
 * verification is the boundary, and it runs first.
 */
export async function isBlockedSender(actorUri: string): Promise<boolean> {
  try {
    const blocked = await prisma.blockedActor.findUnique({
      where: { actorUri },
      select: { id: true },
    });
    return !!blocked;
  } catch {
    return false;
  }
}
