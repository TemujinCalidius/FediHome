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
 * Normalise a domain for storage and comparison: lowercased, no port, no
 * trailing dot, no leading `@` or scheme someone may have pasted in.
 */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  if (!d) return "";
  // Accept a pasted URL or @handle@domain as well as a bare domain — people
  // will paste whatever they have to hand.
  if (d.includes("://")) {
    try {
      d = new URL(d).hostname;
    } catch {
      return "";
    }
  } else if (d.includes("@")) {
    d = d.slice(d.lastIndexOf("@") + 1);
  }
  d = d.split("/")[0].split(":")[0]; // strip any path / port
  while (d.endsWith(".")) d = d.slice(0, -1); // trailing dot is the same host
  return d;
}

/**
 * The domains a block on `host` should cover: the host itself and every parent.
 * Blocking `spam.example` is meant to stop `a.spam.example` too — an instance
 * that can hand out subdomains could otherwise sidestep the block endlessly.
 * Bounded by the label count, so it can't be blown up by a long hostname.
 */
export function domainChain(host: string): string[] {
  const parts = host.split(".").filter(Boolean);
  const out: string[] = [];
  // Stop at two labels: never let a block on "example.com" be tested as "com".
  for (let i = 0; i + 1 < parts.length; i++) out.push(parts.slice(i).join("."));
  return out.length > 0 ? out : parts;
}

/**
 * Whether an incoming activity from this actor should be dropped — because the
 * actor is blocked, or because their whole instance is.
 *
 * Fails **open** on a database error: an inbox that rejects everything because
 * the DB hiccuped is a worse failure than briefly honouring one activity from a
 * blocked actor. Blocking is a preference, not a security boundary — signature
 * verification is the boundary, and it runs first.
 */
export async function isBlockedSender(actorUri: string): Promise<boolean> {
  try {
    const host = actorHost(actorUri);
    const [actor, domain] = await Promise.all([
      prisma.blockedActor.findUnique({ where: { actorUri }, select: { id: true } }),
      host
        ? prisma.blockedDomain.findFirst({
            where: { domain: { in: domainChain(host) } },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    return !!actor || !!domain;
  } catch {
    return false;
  }
}
