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

