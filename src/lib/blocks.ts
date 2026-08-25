import { prisma } from "./db";

/**
 * Block enforcement, inbound and outbound.
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
 *
 * **Both directions, and they're not symmetric (#379).** For a long time only
 * the inbound half existed: we stopped listening to blocked accounts but kept
 * talking to them — outbound follows, DMs, likes, replies and queued retries all
 * still initiated contact. `blockedRecipient()` is the outbound half, and it
 * differs from `isBlockedSender()` in two deliberate ways:
 *
 *   - **It decides actor blocks only from an actor URI the caller supplies,
 *     never from the inbox.** A shared inbox like `https://mastodon.social/inbox`
 *     serves every account on the host; refusing it because one of them is
 *     blocked would black-hole the whole instance. Domain blocks *are* decidable
 *     from the inbox host, because a blocked host is blocked whoever it serves.
 *   - **It fails CLOSED**, where the inbound path fails open. The asymmetry is
 *     reversibility: an inbound activity wrongly stored is a row the next purge
 *     deletes and nobody outside ever knew; an outbound one wrongly delivered is
 *     a signed packet sitting on a blocked person's server, and there is no
 *     unsend. Failing closed costs nothing in availability terms either — every
 *     caller already read its recipient from the same database, so if that's
 *     down there is nothing to deliver to. A DB error is reported as
 *     **non-permanent** so the retry queue picks it up rather than dropping the
 *     activity outright.
 */

/**
 * Lowercased HOSTNAME of a URI, or `null` if it isn't a usable URL.
 *
 * `.hostname`, not `.host`: the port must not survive. `BlockedDomain.domain` is
 * stored port-less (via `normalizeDomain`) and `domainChain` splits on ".", so a
 * host of `spam.example:8443` produced the single candidate `"spam.example:8443"`
 * — which never matches a stored row. An actor served on a non-default port was
 * therefore not domain-blocked at all, inbound or outbound (#379).
 */
export function uriHostname(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** @deprecated Kept as the historical name for `uriHostname`. */
export const actorHost = uriHostname;

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
    const host = uriHostname(actorUri);
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

/* ------------------------------ outbound (#379) ----------------------------- */

export type RecipientBlock =
  | { blocked: false }
  /** Policy refusal — retrying can never help, so callers must discard. */
  | { blocked: true; reason: "actor" | "domain"; permanent: true }
  /** The block list was unreadable. Refuse, but let the queue try again later. */
  | { blocked: true; reason: "unavailable"; permanent: false };

const NOT_BLOCKED: RecipientBlock = { blocked: false };

/** Domain-block candidates for a URI, or `[]` when it isn't parseable. */
function hostCandidates(uri: string | null | undefined): string[] {
  if (!uri) return [];
  const host = uriHostname(uri);
  return host ? domainChain(host) : [];
}

/**
 * Should we refuse to send to this recipient?
 *
 * `actorUri` is optional ONLY because some senders genuinely have no single
 * recipient — a queued `FailedDelivery` row carries just an inbox, which may be
 * shared. Omitting it means actor-level blocks are not enforced for that call,
 * which is correct rather than a shortcut; see the module comment.
 */
export async function blockedRecipient(target: {
  inbox: string;
  actorUri?: string | null;
}): Promise<RecipientBlock> {
  const { inbox, actorUri } = target;
  // Chain BOTH hosts: an actor whose URI is on one domain can advertise an inbox
  // on another, and blocking either should stop the delivery.
  const domains = Array.from(new Set([...hostCandidates(inbox), ...hostCandidates(actorUri)]));

  try {
    const [actor, domain] = await Promise.all([
      actorUri
        ? prisma.blockedActor.findUnique({ where: { actorUri }, select: { id: true } })
        : Promise.resolve(null),
      domains.length
        ? prisma.blockedDomain.findFirst({ where: { domain: { in: domains } }, select: { id: true } })
        : Promise.resolve(null),
    ]);
    if (actor) return { blocked: true, reason: "actor", permanent: true };
    if (domain) return { blocked: true, reason: "domain", permanent: true };
    return NOT_BLOCKED;
  } catch {
    return { blocked: true, reason: "unavailable", permanent: false };
  }
}

/**
 * The batch form, for follower fan-out: two queries total rather than two per
 * recipient. `unavailable` is all-or-nothing — if the block list can't be read
 * we can't clear anyone.
 */
export async function partitionBlockedRecipients<T extends { inbox: string; actorUri?: string | null }>(
  targets: T[],
): Promise<{ allowed: T[]; blocked: T[]; unavailable: boolean }> {
  if (targets.length === 0) return { allowed: [], blocked: [], unavailable: false };

  const actorUris = targets.map((t) => t.actorUri).filter((u): u is string => !!u);
  const domains = Array.from(
    new Set(targets.flatMap((t) => [...hostCandidates(t.inbox), ...hostCandidates(t.actorUri)])),
  );

  try {
    const [actors, blockedDomains] = await Promise.all([
      actorUris.length
        ? prisma.blockedActor.findMany({ where: { actorUri: { in: actorUris } }, select: { actorUri: true } })
        : Promise.resolve([]),
      domains.length
        ? prisma.blockedDomain.findMany({ where: { domain: { in: domains } }, select: { domain: true } })
        : Promise.resolve([]),
    ]);
    const blockedActors = new Set(actors.map((a) => a.actorUri));
    const blockedHosts = new Set(blockedDomains.map((d) => d.domain));

    const allowed: T[] = [];
    const blocked: T[] = [];
    for (const t of targets) {
      const hit =
        (t.actorUri && blockedActors.has(t.actorUri)) ||
        [...hostCandidates(t.inbox), ...hostCandidates(t.actorUri)].some((h) => blockedHosts.has(h));
      (hit ? blocked : allowed).push(t);
    }
    return { allowed, blocked, unavailable: false };
  } catch {
    return { allowed: [], blocked: [], unavailable: true };
  }
}

/**
 * Is this host domain-blocked? **Throws** on a database error, unlike everything
 * else here — `follow()` needs to fail closed with a message the owner can act
 * on, rather than quietly proceeding to WebFinger a blocked instance.
 */
export async function isBlockedDomainHost(host: string): Promise<boolean> {
  const chain = domainChain(host);
  if (chain.length === 0) return false;
  const hit = await prisma.blockedDomain.findFirst({ where: { domain: { in: chain } }, select: { id: true } });
  return !!hit;
}

/**
 * Which of these actor URIs are blocked, by account or by instance? (#396)
 *
 * The batch shape `partitionBlockedRecipients` has, for callers that hold actor
 * URIs rather than delivery targets — thread ingestion, where up to 400 statuses
 * arrive at once and a per-status check would be 800 queries. Two queries total,
 * whatever the batch size.
 *
 * Fails **closed**: an unreadable block list returns every URI as blocked, so a
 * database hiccup can't quietly re-import content a block was meant to remove.
 * That is the same direction the outbound path takes and the opposite of
 * `isBlockedSender`, and the asymmetry is deliberate — refusing to ingest costs
 * a thread view the owner can retry, while ingesting wrongly writes rows that
 * only another explicit block will clear.
 */
export async function blockedActorUris(actorUris: string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(actorUris.filter(Boolean)));
  if (unique.length === 0) return new Set();

  const domains = Array.from(new Set(unique.flatMap((u) => hostCandidates(u))));

  try {
    const [actors, blockedDomains] = await Promise.all([
      prisma.blockedActor.findMany({ where: { actorUri: { in: unique } }, select: { actorUri: true } }),
      domains.length
        ? prisma.blockedDomain.findMany({ where: { domain: { in: domains } }, select: { domain: true } })
        : Promise.resolve([]),
    ]);
    const blockedByUri = new Set(actors.map((a) => a.actorUri));
    const blockedHosts = new Set(blockedDomains.map((d) => d.domain));

    return new Set(
      unique.filter((u) => blockedByUri.has(u) || hostCandidates(u).some((h) => blockedHosts.has(h))),
    );
  } catch {
    return new Set(unique);
  }
}

/**
 * A `where` fragment excluding blocked actors from a `FediPost` query (#396).
 *
 * Blocking works by purging at block time and gating at ingest, not by filtering
 * on read — which is fine right up until an ingest path is missed, and then the
 * purged rows are simply back with nothing to remove them again. This is the
 * belt to that braces.
 *
 * Returns `{}` when nothing is blocked, so the common case adds no clauses at
 * all. **Never build an empty `OR: []`** — and note the reason this shape is
 * safe: both `FediPost.actorUri` and `FediPost.domain` are NOT NULL, so
 * `NOT { OR [...] }` can't hit SQL three-valued logic. A nullable column here
 * would silently drop every row whose value is NULL, which is exactly how a
 * filter like this empties a whole feed.
 */
export async function blockedPostFilter(): Promise<Record<string, unknown>> {
  try {
    const [actors, domains] = await Promise.all([
      prisma.blockedActor.findMany({ select: { actorUri: true } }),
      prisma.blockedDomain.findMany({ select: { domain: true } }),
    ]);
    if (actors.length === 0 && domains.length === 0) return {};

    return {
      NOT: {
        OR: [
          ...(actors.length ? [{ actorUri: { in: actors.map((a) => a.actorUri) } }] : []),
          // Subdomains too, matching domainChain's semantics on the ingest side.
          ...domains.flatMap((d) => [{ domain: d.domain }, { domain: { endsWith: `.${d.domain}` } }]),
        ],
      },
    };
  } catch {
    // A filter we couldn't build must not empty the feed — the ingest gates and
    // the purge are still in force.
    return {};
  }
}

/**
 * Is this Bluesky account blocked, by DID or by handle domain? (#393)
 *
 * Bluesky identities aren't URLs, so the URL-shaped helpers above don't apply:
 * `uriHostname("did:plc:abc")` is `null`, and a handle like
 * `alice.spam.example` has no scheme. A Bluesky block is therefore stored as
 * the **DID** in `BlockedActor` — which is also what `FediPost.actorUri` holds
 * for a Bluesky row, so the two match directly.
 *
 * The handle still carries a domain, and a domain block should cover it:
 * blocking `spam.example` covers `alice.spam.example`, the same subdomain
 * semantics `domainChain` gives the fediverse side.
 *
 * Fails **closed**, like the other ingest-side check — see `blockedActorUris`.
 */
export async function isBlueskyBlocked(actor: { did: string; handle?: string | null }): Promise<boolean> {
  try {
    const candidates = actor.handle ? domainChain(actor.handle.toLowerCase()) : [];
    const [byDid, byDomain] = await Promise.all([
      prisma.blockedActor.findUnique({ where: { actorUri: actor.did }, select: { id: true } }),
      candidates.length
        ? prisma.blockedDomain.findFirst({ where: { domain: { in: candidates } }, select: { id: true } })
        : Promise.resolve(null),
    ]);
    return !!byDid || !!byDomain;
  } catch {
    return true;
  }
}

/**
 * The handle we already hold on file for a Bluesky DID.
 *
 * The domain half of `isBlueskyBlocked` is derived from the HANDLE — a DID
 * carries no domain — so every outbound caller needs one, and none of them
 * reliably has one to hand. Rather than fetching a profile (which is contact
 * with the very account we may be about to refuse), look in the rows we already
 * store: the graph tables from a Bluesky sync, then any DM they have sent us.
 *
 * Returns `null` when we simply don't know them, and `null` ABSTAINS — the DID
 * lookup still runs, so an account block always holds; only the domain half is
 * unavailable. That is the honest answer, and it is why nothing here invents a
 * handle out of the DID: `domainChain("did:web:sub.evil.example")` yields
 * `evil.example` and `domainChain("did:plc:abc")` yields the DID itself, so
 * feeding a DID in matches on the DID *method* rather than on identity (#577).
 *
 * Swallows its own errors to `null` rather than throwing. A real outage takes
 * `isBlueskyBlocked` down too, and that fails CLOSED — so the refusal still
 * happens; this only decides how much we know while deciding it.
 */
async function knownBlueskyHandle(did: string): Promise<string | null> {
  if (!did) return null;
  try {
    const [following, follower, dm] = await Promise.all([
      prisma.blueskyFollowing.findUnique({ where: { did }, select: { handle: true } }),
      prisma.blueskyFollower.findUnique({ where: { did }, select: { handle: true } }),
      prisma.directMessage.findFirst({
        where: { source: "bluesky", senderUri: did, isOutgoing: false },
        select: { senderHandle: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const dmHandle = dm?.senderHandle?.includes(".") ? dm.senderHandle : null;
    return following?.handle ?? follower?.handle ?? dmHandle ?? null;
  } catch {
    return null;
  }
}

/**
 * Refuse outbound contact with a blocked Bluesky account (#577).
 *
 * THE ONE ENTRY POINT for every outbound Bluesky path, and the reason it exists
 * rather than each surface calling `isBlueskyBlocked` itself: the fediverse has
 * a chokepoint — `deliverActivity` gates every recipient before signing, so a
 * block covers follows, DMs, likes and replies in one place and a NEW outbound
 * path is covered the day it is written. Bluesky has no equivalent: posts, likes,
 * follows and chat messages all leave through different atproto methods. So the
 * chokepoint has to be built, and this is it.
 *
 * #563 gated likes and reposts. It did not count DMs, replies, follows or
 * crossposted replies as call sites, and all four went out unchecked (#577).
 *
 * Pass `handle` when the caller genuinely has one — the address an operator
 * typed, say. Otherwise it is resolved from local rows.
 */
export async function blockedBlueskyAccount(
  did: string,
  handle?: string | null,
): Promise<boolean> {
  const known = handle?.includes(".") ? handle : await knownBlueskyHandle(did);
  return isBlueskyBlocked({ did, handle: known });
}

/** The author's DID is the authority segment of an `at://` URI. */
function didOfPost(bskyUri: string): string {
  return bskyUri.replace("at://", "").split("/")[0];
}

/**
 * Refuse outbound contact with the author of a Bluesky post (#577).
 *
 * Liking, reposting and REPLYING all notify the author, so all three fall under
 * the same guarantee. The `FediPost` row we already store for the post carries
 * the author's handle in `username`, which is where the domain half comes from
 * without asking Bluesky anything.
 */
export async function blockedBlueskyPostAuthor(bskyUri: string): Promise<boolean> {
  const did = didOfPost(bskyUri);
  let handle: string | null = null;
  try {
    const row = await prisma.fediPost.findFirst({
      where: { bskyUri },
      select: { username: true },
    });
    handle = row?.username ?? null;
  } catch {
    /* fall back to the graph tables below */
  }
  return blockedBlueskyAccount(did, handle);
}


/**
 * Which of these DM senders are blocked? (#564)
 *
 * DMs need their own helper, and the reason is structural rather than
 * incidental. `blockedPostFilter` works because `FediPost` carries a `domain`
 * COLUMN, so the domain half is expressible in SQL. `DirectMessage` has no such
 * column: the domain lives inside `senderHandle`, in two different formats —
 * `@user@domain` for the fediverse and `handle.bsky.social` for Bluesky.
 *
 * THE POLYMORPHIC KEY IS THE TRAP. `senderUri` holds an actorUri for fedi and a
 * DID for Bluesky. Passing the whole set to `blockedActorUris` looks right and
 * silently half-works: `hostCandidates("did:plc:…")` is `[]`, because
 * `uriHostname` finds no host in a DID, so the domain query is skipped for
 * every Bluesky row. A `bsky.social` domain block would not cover
 * `alice.bsky.social`. That is exactly the failure #563 had, from the other
 * direction — the Bluesky half of blocking being quietly dropped.
 *
 * So the domain candidates branch on `source`, while the actor lookup does not:
 * fediverse actorUris and Bluesky DIDs both live in `BlockedActor.actorUri`.
 *
 * Fails **CLOSED**, like `blockedActorUris` and `isBlueskyBlocked`. The two
 * helpers here that fail open do so for availability — an empty feed is a worse
 * outage than one unfiltered post. That reasoning doesn't transfer: a DM list
 * that briefly shows nothing is a far smaller harm than a blocked person's
 * message reaching the owner, and the database is already down in that case.
 *
 * Returns the blocked `senderUri` values, so callers can express the exclusion
 * as `NOT { senderUri: { in: [...] } }` IN THE QUERY. That matters — both DM
 * reads cap at `take: 200`, and filtering after the fetch would silently shrink
 * the page and drop legitimate messages that fell off the end.
 */
export async function blockedDmSenders(
  rows: { senderUri: string; senderHandle: string; source: string }[],
): Promise<Set<string>> {
  const unique = new Map<string, { senderHandle: string; source: string }>();
  for (const r of rows) {
    if (r.senderUri) unique.set(r.senderUri, { senderHandle: r.senderHandle, source: r.source });
  }
  if (unique.size === 0) return new Set();

  const uris = [...unique.keys()];
  const domainsFor = (uri: string, meta: { senderHandle: string; source: string }) =>
    meta.source === "bluesky"
      ? domainChain((meta.senderHandle || "").toLowerCase()).filter((d) => d.includes("."))
      : hostCandidates(uri);

  const candidates = [
    ...new Set([...unique.entries()].flatMap(([uri, meta]) => domainsFor(uri, meta))),
  ];

  try {
    const [actors, domains] = await Promise.all([
      prisma.blockedActor.findMany({ where: { actorUri: { in: uris } }, select: { actorUri: true } }),
      candidates.length
        ? prisma.blockedDomain.findMany({ where: { domain: { in: candidates } }, select: { domain: true } })
        : Promise.resolve([]),
    ]);
    const byUri = new Set(actors.map((a) => a.actorUri));
    const byDomain = new Set(domains.map((d) => d.domain));

    return new Set(
      uris.filter(
        (u) => byUri.has(u) || domainsFor(u, unique.get(u)!).some((d) => byDomain.has(d)),
      ),
    );
  } catch {
    return new Set(uris);
  }
}

/**
 * The distinct senders currently stored, so a read can resolve the blocked set
 * before it queries — see the `take: 200` note on `blockedDmSenders`.
 */
export async function blockedDmSenderUris(): Promise<string[]> {
  try {
    const senders = await prisma.directMessage.findMany({
      where: { isOutgoing: false },
      select: { senderUri: true, senderHandle: true, source: true },
      distinct: ["senderUri"],
    });
    return [...(await blockedDmSenders(senders))];
  } catch {
    // Fail closed is not available here — we cannot name senders we failed to
    // read. The callers' queries therefore stay unfiltered on a DB error, which
    // is the same posture their own `findMany` already has: it would throw too.
    return [];
  }
}
