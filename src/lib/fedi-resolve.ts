import { assertPublicHost } from "./url-guard";
import { prisma } from "./db";

export interface ResolvedFediActor {
  actorUri: string;
  inbox: string;
  sharedInbox: string | null;
  username: string;
  domain: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * Resolve `@user@domain` (or `user@domain`) to an ActivityPub actor record
 * via WebFinger + actor fetch. Returns null if any lookup fails or the host
 * fails the SSRF guard. Used by the new-DM compose flow so admins can DM any
 * Fediverse handle, not only ones already in FediFollower / FediFollowing.
 */
export async function resolveFediActorByHandle(
  rawHandle: string
): Promise<ResolvedFediActor | null> {
  const cleaned = rawHandle.trim().replace(/^@/, "");
  const [username, domain] = cleaned.split("@");
  if (!username || !domain) return null;

  const wfUrl = `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`;
  if (!(await assertPublicHost(wfUrl))) return null;

  try {
    const wfRes = await fetch(wfUrl, {
      headers: { Accept: "application/jrd+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!wfRes.ok) return null;
    const wfData = await wfRes.json();
    const actorLink = wfData.links?.find(
      (l: { rel: string; type?: string }) =>
        l.rel === "self" && l.type === "application/activity+json"
    );
    if (!actorLink?.href) return null;

    return await resolveFediActorByUri(actorLink.href);
  } catch {
    return null;
  }
}

export async function resolveFediActorByUri(
  actorUri: string
): Promise<ResolvedFediActor | null> {
  if (!(await assertPublicHost(actorUri))) return null;
  try {
    const res = await fetch(actorUri, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const actor = await res.json();
    if (!actor.inbox) return null;

    const sharedInbox =
      actor.endpoints?.sharedInbox ||
      actor.sharedInbox ||
      null;

    return {
      actorUri,
      inbox: actor.inbox,
      sharedInbox,
      username: actor.preferredUsername || "unknown",
      domain: new URL(actorUri).hostname,
      displayName: actor.name || null,
      avatarUrl: actor.icon?.url || null,
    };
  } catch {
    return null;
  }
}

/**
 * Best delivery inbox for an actor URI: a cached FediFollower/FediFollowing's
 * `sharedInbox`→`inbox`, else a live actor fetch. Returns null if unresolvable.
 *
 * Outbound like/boost/reply delivery must use this rather than constructing an
 * inbox from a handle — the inbox path is per-implementation (Mastodon uses
 * `/users/<name>/inbox`, FediHome uses `/ap/inbox`, …), so it has to come from
 * the actor's advertised/stored value or delivery 404s. (#110)
 */
export async function resolveActorInbox(actorUri: string): Promise<string | null> {
  try {
    const follower = await prisma.fediFollower.findUnique({
      where: { actorUri },
      select: { inbox: true, sharedInbox: true },
    });
    if (follower) return follower.sharedInbox || follower.inbox;

    const following = await prisma.fediFollowing.findUnique({
      where: { actorUri },
      select: { inbox: true },
    });
    if (following) return following.inbox;

    const live = await resolveFediActorByUri(actorUri);
    return live ? live.sharedInbox || live.inbox : null;
  } catch {
    return null;
  }
}
