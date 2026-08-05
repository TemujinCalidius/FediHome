import { prisma } from "./db";
import { guardedFetch } from "./safe-fetch";
import { resolveFediActorByUri } from "./fedi-resolve";
import { isBlockedSender } from "./blocks";
import { sanitizeHtml, escapeText } from "./sanitize";
import { processAttachments, fetchLinkEmbed, removeFediMediaFiles } from "./fedi-media";
import { getRuntimeSiteConfig } from "./site-settings";
import { getSiteUrl } from "./identity";

/**
 * Explore: discovering people through the ones you already follow (#386).
 *
 * The premise is that the trust signal is already in the data. Someone the owner
 * chose to follow thought a stranger's post was worth boosting, or worth
 * replying to — so that post is worth showing, and nothing algorithmic or
 * firehose-shaped is involved.
 *
 * TWO SIGNALS, AND ONLY TWO. ActivityPub decides which are available, not us:
 *
 *  - **Boosts** already arrive. An `Announce` is delivered to the booster's
 *    followers, `handleBoost` fetches the original and stores it — and every
 *    timeline read then filters it back out with `boostedBy: null`. So the
 *    content has been landing on disk and being thrown away all along.
 *  - **Replies** already arrive too: a reply is addressed to the public
 *    collection and cc'd to the replier's followers. What never arrives is the
 *    post being replied TO, so the database accumulates `inReplyTo` pointers at
 *    exactly the strangers' posts this feature wants and never resolves them.
 *    That is what this module fetches.
 *  - **Likes cannot be used, ever.** A `Like` is delivered only to the author of
 *    the liked post, and Mastodon publishes no public `liked` collection. There
 *    is nowhere to fetch the data from; it is not a question of effort.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: subscribe to a relay. A relay is the
 * firehose that fills a small instance's federated timeline with every public
 * post from every participating server — the opposite of this feature's premise,
 * and a different risk profile. It belongs to its own issue if it ever happens.
 *
 * Off unless the owner turns it on. This stores other people's posts on their
 * disk, under their domain, so it is not something to be opted into by upgrading.
 */

/** `discoveredVia` values. Also the vocabulary the UI labels rows with. */
export const VIA_BOOST = "boost";
export const VIA_REPLY_PARENT = "reply-parent";

const PUBLIC_URI = "https://www.w3.org/ns/activitystreams#Public";

/** How many delivered replies to look through for unresolved parents per run. */
const CANDIDATE_SCAN = 500;
/** Hard ceiling on outbound fetches per run, whatever the scan turns up. */
const MAX_FETCH_PER_RUN = 10;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Parents we tried and won't retry for a while: unreachable, not a Note, not
 * public, or by someone blocked. Without this, a permanently-dead parent is
 * re-fetched every single run for as long as the reply that points at it stays
 * inside the lookback window — and it would crowd out live candidates, because
 * the per-run budget is small on purpose.
 *
 * Bounded on both axes (age and count) so it can't grow without limit on a busy
 * instance; the oldest entries are dropped first. Held on `globalThis` for the
 * reason documented in scheduler.ts: instrumentation.ts reaches the scheduler
 * through a *dynamic* import, so anything that later imports this module
 * statically resolves to a second module instance — and a module-level `Map`
 * would silently be a second, always-empty cache rather than a shared one.
 */
const MISS_TTL_MS = 6 * 60 * 60_000;
const MAX_MISSES = 2_000;

const globalExplore = globalThis as typeof globalThis & {
  __fedihomeExploreMisses?: Map<string, number>;
};

function misses(): Map<string, number> {
  if (!globalExplore.__fedihomeExploreMisses) globalExplore.__fedihomeExploreMisses = new Map();
  return globalExplore.__fedihomeExploreMisses;
}

function recentlyMissed(apId: string, now: number): boolean {
  const at = misses().get(apId);
  if (at === undefined) return false;
  if (now - at >= MISS_TTL_MS) {
    misses().delete(apId);
    return false;
  }
  return true;
}

function noteMiss(apId: string, now: number): void {
  const m = misses();
  m.delete(apId); // re-insert so Map iteration order is oldest-first
  m.set(apId, now);
  while (m.size > MAX_MISSES) {
    const oldest = m.keys().next();
    if (oldest.done) break;
    m.delete(oldest.value);
  }
}

/** Testing seam — the cache outlives a single run by design. */
export function resetExploreMissCache(): void {
  globalExplore.__fedihomeExploreMisses = new Map();
}

export interface ExploreSummary {
  /** Distinct unresolved parents the scan turned up. */
  candidates: number;
  /** Outbound fetches actually made (capped by MAX_FETCH_PER_RUN). */
  fetched: number;
  /** New rows written. */
  stored: number;
  /** Fetched but refused: not public, blocked author, not a post, unreachable. */
  skipped: number;
  /** Rows deleted to stay under the owner's cap. */
  pruned: number;
}

const EMPTY: ExploreSummary = { candidates: 0, fetched: 0, stored: 0, skipped: 0, pruned: 0 };

function addressees(note: Record<string, unknown>): string[] {
  const one = (v: unknown) => (Array.isArray(v) ? (v as string[]) : [v as string]).filter(Boolean);
  return [...one(note.to), ...one(note.cc)];
}

/**
 * Public-to-the-world, in the ActivityPub sense.
 *
 * Checked against the canonical URI only, not the `as:Public` / `Public`
 * shorthands some implementations emit. Being strict costs us a post we could
 * have shown; being lax stores a followers-only post from a stranger under the
 * owner's domain, which is not ours to hold whoever replied to it. The failure
 * directions are not comparable, so this errs the cheap way — and it matches
 * what `handleNote` in the inbox already does.
 */
export function isPublicNote(note: Record<string, unknown>): boolean {
  return addressees(note).includes(PUBLIC_URI);
}

/**
 * Fetch the posts that people the owner follows have replied to.
 *
 * Every safety gate the inbox applies is applied here too, and for the same
 * reasons — this is a new ingestion path, and #353 is the precedent: a followed
 * account boosting a blocked person's post put that person's content, name and
 * avatar straight back into the feed, because the only block check looked at the
 * SENDER. Here there is no sender at all; we chose to go and get it. So:
 *
 *  - `guardedFetch`, which re-validates every redirect hop (#433/#434);
 *  - the block gate runs on the ORIGINAL AUTHOR, before anything is stored and
 *    before any media is fetched;
 *  - non-public objects are dropped;
 *  - anything already ours is skipped before a request is even made.
 */
export async function resolveReplyParents(now: Date = new Date()): Promise<ExploreSummary> {
  const site = await getRuntimeSiteConfig();
  if (!site.explore.enabled || !site.explore.replyParents) return EMPTY;

  const followed = (await prisma.fediFollowing.findMany({ select: { actorUri: true } }))
    .map((f) => f.actorUri);
  if (followed.length === 0) return EMPTY;

  const cutoff = new Date(now.getTime() - site.explore.lookbackDays * 24 * 60 * 60_000);

  // Delivered replies FROM PEOPLE WE FOLLOW. The actor filter is the whole trust
  // signal — replies from anyone else in this table are replies to the owner's
  // own content, whose parent we already have by definition.
  const replies = await prisma.fediPost.findMany({
    where: {
      source: "fedi",
      isOutgoing: false,
      viaLookup: false,
      discoveredVia: null,
      boostedBy: null,
      inReplyTo: { not: null },
      createdAt: { gte: cutoff },
      actorUri: { in: followed },
    },
    select: { inReplyTo: true },
    orderBy: { createdAt: "desc" },
    take: CANDIDATE_SCAN,
  });

  const nowMs = now.getTime();
  const siteUrl = getSiteUrl();
  const wanted = [
    ...new Set(replies.map((r) => r.inReplyTo).filter((v): v is string => Boolean(v))),
  ].filter((apId) => !apId.startsWith(siteUrl) && !recentlyMissed(apId, nowMs));
  if (wanted.length === 0) return EMPTY;

  // Anything we already hold, in any of the three tables an inReplyTo can point
  // at. Done as three set lookups rather than per-candidate queries so the scan
  // stays one round-trip each however many candidates there are.
  const [haveFedi, havePosts, havePhotos] = await Promise.all([
    prisma.fediPost.findMany({ where: { apId: { in: wanted } }, select: { apId: true } }),
    prisma.post.findMany({ where: { apId: { in: wanted } }, select: { apId: true } }),
    prisma.photo.findMany({ where: { apId: { in: wanted } }, select: { apId: true } }),
  ]);
  const have = new Set(
    [...haveFedi, ...havePosts, ...havePhotos].map((r) => r.apId).filter(Boolean) as string[],
  );

  const todo = wanted.filter((apId) => !have.has(apId)).slice(0, MAX_FETCH_PER_RUN);
  const summary: ExploreSummary = { ...EMPTY, candidates: wanted.length - have.size };

  for (const apId of todo) {
    summary.fetched++;
    const stored = await fetchAndStoreParent(apId, nowMs);
    if (stored) summary.stored++;
    else summary.skipped++;
  }

  summary.pruned = await pruneExploreOverflow(site.explore.maxStored);
  return summary;
}

async function fetchAndStoreParent(apId: string, nowMs: number): Promise<boolean> {
  try {
    const res = await guardedFetch(apId, {
      crossOrigin: true,
      label: "explore reply-parent fetch",
      timeoutMs: FETCH_TIMEOUT_MS,
      init: { headers: { Accept: "application/activity+json, application/ld+json" } },
    });
    if (!res.ok) {
      noteMiss(apId, nowMs);
      return false;
    }
    const note = (await res.json()) as Record<string, unknown>;
    if (note.type !== "Note" && note.type !== "Article") {
      noteMiss(apId, nowMs);
      return false;
    }
    if (!isPublicNote(note)) {
      noteMiss(apId, nowMs);
      return false;
    }

    const authorUri =
      typeof note.attributedTo === "string"
        ? note.attributedTo
        : (note.attributedTo as { id?: string } | undefined)?.id;
    if (!authorUri) {
      noteMiss(apId, nowMs);
      return false;
    }

    // BEFORE the actor fetch and BEFORE any media is downloaded. A blocked
    // person's avatar landing in the cache is the same leak as their post
    // landing in the feed (#353).
    if (await isBlockedSender(authorUri)) {
      noteMiss(apId, nowMs);
      return false;
    }

    const author = await resolveFediActorByUri(authorUri);
    if (!author) {
      noteMiss(apId, nowMs);
      return false;
    }

    // Articles carry their title in `name`; FediPost has no title column, so it
    // becomes a heading — the same treatment handleNote gives them.
    const title = typeof note.name === "string" ? note.name.trim() : "";
    const body = (note.content as string) || "";
    const raw = title ? `<h2>${escapeText(title)}</h2>${body}` : body;
    const content = sanitizeHtml(raw);

    const { urls, types, remotes } = await processAttachments(note.attachment as unknown[] | undefined);
    const embed = await fetchLinkEmbed(raw);

    await prisma.fediPost.upsert({
      where: { apId },
      create: {
        actorUri: authorUri,
        apId,
        content,
        contentHtml: content,
        mediaUrls: urls,
        mediaTypes: types,
        mediaRemoteUrls: remotes,
        // A thread ROOT has no inReplyTo, so this is usually null — which is
        // precisely why discoveredVia has to exist. Without it the row is
        // indistinguishable from a post by someone the owner follows.
        inReplyTo: (note.inReplyTo as string) || null,
        conversationId:
          (note.conversation as string) || (note.context as string) || (note.id as string) || apId,
        discoveredVia: VIA_REPLY_PARENT,
        username: author.username,
        domain: author.domain,
        displayName: author.displayName,
        avatarUrl: author.avatarUrl,
        publishedAt: note.published ? new Date(note.published as string) : new Date(),
        embedUrl: embed?.url || null,
        embedTitle: embed?.title || null,
        embedDescription: embed?.description || null,
        embedImage: embed?.image || null,
        embedSiteName: embed?.siteName || null,
      },
      // Raced with a delivery or a thread expansion between the `have` check and
      // here. Whatever wrote it first has better provenance than we do — this
      // path never promotes a row INTO the feed, and never demotes one out.
      update: {},
    });
    return true;
  } catch {
    noteMiss(apId, nowMs);
    return false;
  }
}

/**
 * Keep the number of stored reply-parents under the owner's cap, oldest first.
 *
 * Scoped to `discoveredVia: VIA_REPLY_PARENT` on purpose. Boost rows are ordinary
 * ingest that predates this feature and are already covered by the retention
 * sweep; capping them here would change behaviour nobody asked to change.
 *
 * Cached media is unlinked for the rows removed — otherwise the cap would bound
 * the table and quietly leave the disk to grow, which is the half-fix that makes
 * a limit feel like it isn't working.
 */
export async function pruneExploreOverflow(maxStored: number): Promise<number> {
  if (maxStored <= 0) return 0;
  const total = await prisma.fediPost.count({ where: { discoveredVia: VIA_REPLY_PARENT } });
  if (total <= maxStored) return 0;

  const overflow = await prisma.fediPost.findMany({
    where: { discoveredVia: VIA_REPLY_PARENT },
    orderBy: { createdAt: "asc" },
    take: total - maxStored,
    select: { id: true, mediaUrls: true },
  });
  if (overflow.length === 0) return 0;

  // Rows first, files second — an orphaned file is reclaimed by the storage
  // evictor, whereas a row pointing at a deleted file renders a broken image.
  // Same ordering, and the same reason, as the retention sweep.
  const { count } = await prisma.fediPost.deleteMany({
    where: { id: { in: overflow.map((p) => p.id) } },
  });
  await removeFediMediaFiles(overflow.flatMap((p) => p.mediaUrls)).catch(() => 0);
  return count;
}
