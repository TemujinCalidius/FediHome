import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireBlueskyAgent } from "@/lib/bluesky-agent";
import { isBlueskyBlocked } from "@/lib/blocks";

/**
 * Like and repost on Bluesky, for posts imported into the timeline (#393).
 *
 * The fediverse equivalents in `fedi-interactions.ts` build a `Like` or
 * `Announce` activity and deliver it to the author's inbox. Bluesky has no
 * inbox: you write a record into your own repo referencing the target, and
 * undoing it means deleting that record by its URI.
 *
 * **We deliberately do not cache the target's `cid` or our own like/repost
 * record URIs.** Both are one `getPosts()` call away, and Bluesky is the
 * authority on whether we currently like something — a cached URI goes stale
 * the moment the same account is used from the Bluesky app, which for a
 * single-owner site is the normal case rather than an edge case.
 */

interface BskyViewerState {
  cid: string;
  /** URI of OUR like record on this post, if we have one. */
  likeUri: string | null;
  /** URI of OUR repost record on this post, if we have one. */
  repostUri: string | null;
}

async function viewerState(
  agent: Awaited<ReturnType<typeof requireBlueskyAgent>>,
  uri: string,
): Promise<BskyViewerState | null> {
  const res = await agent.getPosts({ uris: [uri] });
  const p = res.data.posts?.[0] as
    | { cid?: string; viewer?: { like?: string; repost?: string } }
    | undefined;
  if (!p?.cid) return null;
  return { cid: p.cid, likeUri: p.viewer?.like ?? null, repostUri: p.viewer?.repost ?? null };
}

/** The author's DID is the authority segment of an `at://` URI. */
function didOf(uri: string): string {
  return uri.replace("at://", "").split("/")[0];
}

/**
 * Shared preamble: refuse blocked accounts, then resolve what we need to act.
 *
 * Liking or reposting notifies the author, so both fall under the guarantee in
 * `blocks.ts` that a block never sends anything to the blocked party — the same
 * reason every outbound fediverse path is gated (#379).
 */
async function prepare(bskyUri: string) {
  // THE HANDLE MATTERS AS MUCH AS THE DID (#563). isBlueskyBlocked derives its
  // domain candidates from the handle — `actor.handle ? domainChain(…) : []` —
  // so calling it with a DID alone skips the blockedDomain query entirely and a
  // DOMAIN block silently collapses to a DID lookup. Blocking `spam.example`
  // then failed to stop a like going to `alice.spam.example`, and a like or
  // repost notifies the author.
  //
  // The row we already store for this post carries it: `username` holds the
  // full Bluesky handle. bluesky-feed.ts:339 passes both on the ingest side,
  // which is why the block held coming in and not going out — the asymmetry
  // #379 exists to prevent.
  const did = didOf(bskyUri);
  const row = await prisma.fediPost.findFirst({
    where: { bskyUri },
    select: { username: true },
  });
  if (await isBlueskyBlocked({ did, handle: row?.username ?? null })) {
    return { error: NextResponse.json({ error: "recipient is blocked" }, { status: 409 }) };
  }
  const agent = await requireBlueskyAgent();
  // null = deleted upstream, or no longer visible to us. Reported as `gone`
  // rather than an error, because the right response differs by direction:
  // there is nothing to LIKE, but an UNDO should still clear our flag.
  const state = await viewerState(agent, bskyUri);
  return { agent, state, gone: state === null };
}

const NOT_FOUND = () => NextResponse.json({ error: "post not found on Bluesky" }, { status: 404 });

/** Keep our local flag in step with what we just did on Bluesky. */
async function setFlag(bskyUri: string, data: { likedByMe?: boolean; boostedByMe?: boolean }) {
  await prisma.fediPost.updateMany({ where: { bskyUri }, data });
}

export async function blueskyLike(bskyUri: string): Promise<NextResponse> {
  const { agent, state, gone, error } = await prepare(bskyUri);
  if (error) return error;
  if (gone) return NOT_FOUND();
  // Idempotent: if a like record already exists — made in the Bluesky app, say —
  // don't write a second one, just make our flag agree.
  if (!state!.likeUri) await agent!.like(bskyUri, state!.cid);
  await setFlag(bskyUri, { likedByMe: true });
  return NextResponse.json({ success: true });
}

export async function blueskyUnlike(bskyUri: string): Promise<NextResponse> {
  const { agent, state, gone, error } = await prepare(bskyUri);
  if (error) return error;
  // A post deleted upstream takes our like with it. Refusing here would leave
  // the heart lit with no way to clear it: the row survives, and every
  // subsequent click would 404 and get re-filled by the client's revert. So
  // clear the flag and report success.
  if (!gone && state!.likeUri) await agent!.deleteLike(state!.likeUri);
  await setFlag(bskyUri, { likedByMe: false });
  return NextResponse.json({ success: true });
}

export async function blueskyRepost(bskyUri: string): Promise<NextResponse> {
  const { agent, state, gone, error } = await prepare(bskyUri);
  if (error) return error;
  if (gone) return NOT_FOUND();
  if (!state!.repostUri) await agent!.repost(bskyUri, state!.cid);
  await setFlag(bskyUri, { boostedByMe: true });
  return NextResponse.json({ success: true });
}

export async function blueskyUnrepost(bskyUri: string): Promise<NextResponse> {
  const { agent, state, gone, error } = await prepare(bskyUri);
  if (error) return error;
  // Same reasoning as blueskyUnlike.
  if (!gone && state!.repostUri) await agent!.deleteRepost(state!.repostUri);
  await setFlag(bskyUri, { boostedByMe: false });
  return NextResponse.json({ success: true });
}
