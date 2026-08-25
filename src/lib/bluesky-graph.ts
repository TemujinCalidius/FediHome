import { prisma } from "./db";
import { blockedBlueskyAccount } from "./blocks";
import { getBlueskyAgent } from "./bluesky-agent";

type ProfileView = {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  viewer?: { following?: string };
};

/**
 * Sync the authenticated user's full Bluesky social graph (followers + follows)
 * into the BlueskyFollower / BlueskyFollowing tables. Rows whose DID is not seen
 * in this run are deleted, so unfollows propagate.
 */
export async function syncBlueskyGraph(): Promise<{ followers: number; following: number }> {
  // The shared agent, so the configured PDS is honoured (#541). This used to
  // build its own against a hardcoded bsky.social.
  const agent = await getBlueskyAgent();
  if (!agent) return { followers: 0, following: 0 };
  const actor = agent.session!.did;

  const seenFollowerDids = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await agent.getFollowers({ actor, cursor, limit: 100 });
    if (!res.success) break;
    for (const p of res.data.followers as ProfileView[]) {
      seenFollowerDids.add(p.did);
      await prisma.blueskyFollower.upsert({
        where: { did: p.did },
        create: {
          did: p.did,
          handle: p.handle,
          displayName: p.displayName || null,
          avatarUrl: p.avatar || null,
        },
        update: {
          handle: p.handle,
          displayName: p.displayName || null,
          avatarUrl: p.avatar || null,
          fetchedAt: new Date(),
        },
      });
    }
    cursor = res.data.cursor;
  } while (cursor);

  const seenFollowingDids = new Set<string>();
  cursor = undefined;
  do {
    const res = await agent.getFollows({ actor, cursor, limit: 100 });
    if (!res.success) break;
    for (const p of res.data.follows as ProfileView[]) {
      seenFollowingDids.add(p.did);
      await prisma.blueskyFollowing.upsert({
        where: { did: p.did },
        create: {
          did: p.did,
          handle: p.handle,
          displayName: p.displayName || null,
          avatarUrl: p.avatar || null,
          followUri: p.viewer?.following || null,
        },
        update: {
          handle: p.handle,
          displayName: p.displayName || null,
          avatarUrl: p.avatar || null,
          followUri: p.viewer?.following || null,
          fetchedAt: new Date(),
        },
      });
    }
    cursor = res.data.cursor;
  } while (cursor);

  await prisma.blueskyFollower.deleteMany({
    where: { did: { notIn: [...seenFollowerDids] } },
  });
  await prisma.blueskyFollowing.deleteMany({
    where: { did: { notIn: [...seenFollowingDids] } },
  });

  return { followers: seenFollowerDids.size, following: seenFollowingDids.size };
}

/**
 * Follow a Bluesky account by DID. Persists the resulting follow record so we
 * can unfollow later (deleteFollow requires the record URI, not the DID).
 */
export async function followBlueskyAccount(
  did: string,
  handle?: string | null,
): Promise<{ ok: true } | { ok: false; reason: "blocked" }> {
  // REFUSED BEFORE ANY CONTACT (#577). A follow notifies the other account, so
  // it falls under the same guarantee as a like or a reply — and this sits in
  // the library rather than in the route so a second caller cannot skip it,
  // exactly as `deliverActivity` does for every outbound fediverse path (#379).
  //
  // Returned rather than thrown: "you blocked them" is a decision, not a
  // failure, and the route turns it into a 409 instead of a 500.
  if (await blockedBlueskyAccount(did, handle)) return { ok: false, reason: "blocked" };

  // The shared agent, so the configured PDS is honoured (#541). This used to
  // build its own against a hardcoded bsky.social.
  const agent = await getBlueskyAgent();
  if (!agent) throw new Error("Bluesky credentials not configured");

  const result = await agent.follow(did);
  const profile = await agent.getProfile({ actor: did });
  const p = profile.data;

  await prisma.blueskyFollowing.upsert({
    where: { did: p.did },
    create: {
      did: p.did,
      handle: p.handle,
      displayName: p.displayName || null,
      avatarUrl: p.avatar || null,
      followUri: result.uri,
    },
    update: {
      handle: p.handle,
      displayName: p.displayName || null,
      avatarUrl: p.avatar || null,
      followUri: result.uri,
      fetchedAt: new Date(),
    },
  });

  return { ok: true };
}

/**
 * Unfollow a Bluesky account by our BlueskyFollowing row id. Throws if the
 * stored followUri is missing (row predates schema change — re-sync first).
 */
export async function unfollowBlueskyAccount(followingId: string): Promise<void> {
  const row = await prisma.blueskyFollowing.findUnique({ where: { id: followingId } });
  if (!row) throw new Error("Following row not found");
  if (!row.followUri) throw new Error("Missing followUri — sync Bluesky graph and retry");

  // The shared agent, so the configured PDS is honoured (#541). This used to
  // build its own against a hardcoded bsky.social.
  const agent = await getBlueskyAgent();
  if (!agent) throw new Error("Bluesky credentials not configured");

  await agent.deleteFollow(row.followUri);
  await prisma.blueskyFollowing.delete({ where: { id: followingId } });
}

/**
 * Resolve a handle or DID to a DID. Used by the unified Follow form so the
 * user can paste either `name.bsky.social` or `did:plc:...`.
 */
export async function resolveBlueskyActor(handleOrDid: string): Promise<string> {
  const trimmed = handleOrDid.trim().replace(/^@/, "");
  if (trimmed.startsWith("did:")) return trimmed;

  // The shared agent, so the configured PDS is honoured (#541). This used to
  // build its own against a hardcoded bsky.social.
  const agent = await getBlueskyAgent();
  if (!agent) throw new Error("Bluesky credentials not configured");
  const res = await agent.resolveHandle({ handle: trimmed });
  return res.data.did;
}
