import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/auth";
import { resolveFediActorByHandle } from "@/lib/fedi-resolve";
import { assertPublicHost } from "@/lib/url-guard";
import { sanitizeHtml } from "@/lib/sanitize";

/**
 * Remote actor profile (#176) + handle discovery (#177).
 *
 *   GET /api/profile?actor=<actorUri>      → rich profile for an actor already in
 *                                            your network (follower/following/feed)
 *   GET /api/profile?handle=@user@domain   → rich profile if they're known, else a
 *                                            light WebFinger-resolved card (discovery)
 *
 * Read-scoped (owner cookie OR a `read` bearer). GET → no CSRF.
 *
 * The rich path only ever fetches an actor URI sourced from OUR database (a known
 * follower/following/feed actor) — never a raw request URL — so there's no
 * server-side request-forgery surface (same pattern as /api/fedi-post-counts).
 * Discovery of a stranger goes through the shared WebFinger resolver, which is
 * SSRF-guarded and returns only lightweight card fields (no arbitrary fetch here).
 */

const ACTOR_TIMEOUT_MS = 8000;
const COLLECTION_TIMEOUT_MS = 6000;

/** totalItems from an AP collection ref (inline object or a URL). Best-effort. */
async function collectionTotal(ref: unknown): Promise<number | null> {
  if (ref == null) return null;
  if (typeof ref === "object") {
    const t = (ref as { totalItems?: unknown }).totalItems;
    return typeof t === "number" ? t : null;
  }
  if (typeof ref !== "string") return null;
  if (!(await assertPublicHost(ref))) return null;
  try {
    const res = await fetch(ref, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(COLLECTION_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const c = (await res.json()) as { totalItems?: unknown };
    return typeof c.totalItems === "number" ? c.totalItems : null;
  } catch {
    return null;
  }
}

/** Fetch the live actor JSON. `knownUri` must come from our DB, not the request. */
async function fetchActorProfile(knownUri: string) {
  if (!(await assertPublicHost(knownUri))) return null;
  let actor: Record<string, unknown>;
  try {
    const res = await fetch(knownUri, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(ACTOR_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    actor = await res.json();
  } catch {
    return null;
  }
  const username = (actor.preferredUsername as string) || "unknown";
  const domain = new URL(knownUri).hostname;
  const icon = actor.icon as { url?: string } | undefined;
  const image = actor.image as { url?: string } | undefined;
  const [followers, following, posts] = await Promise.all([
    collectionTotal(actor.followers),
    collectionTotal(actor.following),
    collectionTotal(actor.outbox),
  ]);
  return {
    actorUri: knownUri,
    handle: `@${username}@${domain}`,
    displayName: (actor.name as string) || null,
    avatarUrl: icon?.url || null,
    headerUrl: image?.url || null,
    summary: typeof actor.summary === "string" ? sanitizeHtml(actor.summary) : null,
    url: (actor.url as string) || knownUri,
    counts: { followers, following, posts },
    partial: false,
  };
}

/** Look up an actor we already know (by URI) → returns the DB-stored URI. */
async function knownActorUriByUri(uri: string): Promise<string | null> {
  const f =
    (await prisma.fediFollower.findUnique({ where: { actorUri: uri }, select: { actorUri: true } })) ??
    (await prisma.fediFollowing.findUnique({ where: { actorUri: uri }, select: { actorUri: true } })) ??
    (await prisma.fediPost.findFirst({ where: { actorUri: uri }, select: { actorUri: true } }));
  return f?.actorUri ?? null;
}

/** Look up an actor we already know (by handle) → returns the DB-stored URI. */
async function knownActorUriByHandle(username: string, domain: string): Promise<string | null> {
  const f =
    (await prisma.fediFollower.findFirst({ where: { username, domain }, select: { actorUri: true } })) ??
    (await prisma.fediFollowing.findFirst({ where: { username, domain }, select: { actorUri: true } })) ??
    (await prisma.fediPost.findFirst({ where: { username, domain }, select: { actorUri: true } }));
  return f?.actorUri ?? null;
}

export async function GET(req: NextRequest) {
  if (!(await authenticateApiRequest(req, "read")).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const actorParam = (req.nextUrl.searchParams.get("actor") || "").trim();
  const handleParam = (req.nextUrl.searchParams.get("handle") || "").trim();

  // Resolve to a DB-sourced actor URI (rich), or a light WebFinger card for an
  // unknown handle (discovery). Never fetch a raw request URL.
  let knownUri: string | null = null;
  let light: { actorUri: string; handle: string; displayName: string | null; avatarUrl: string | null } | null = null;

  if (actorParam) {
    knownUri = await knownActorUriByUri(actorParam);
    if (!knownUri) {
      return NextResponse.json({ error: "actor not in your network; use ?handle= to discover" }, { status: 404 });
    }
  } else if (handleParam) {
    const [username, domain] = handleParam.replace(/^@/, "").split("@");
    if (!username || !domain) {
      return NextResponse.json({ error: "invalid handle" }, { status: 400 });
    }
    knownUri = await knownActorUriByHandle(username, domain);
    if (!knownUri) {
      // Stranger: SSRF-guarded WebFinger resolve → lightweight card only.
      const r = await resolveFediActorByHandle(handleParam);
      if (!r) {
        return NextResponse.json({ error: "could not resolve handle" }, { status: 404 });
      }
      light = { actorUri: r.actorUri, handle: `@${r.username}@${r.domain}`, displayName: r.displayName, avatarUrl: r.avatarUrl };
    }
  } else {
    return NextResponse.json({ error: "actor or handle required" }, { status: 400 });
  }

  const resolvedUri = knownUri ?? light!.actorUri;
  const [followedByMe, followsMe] = await Promise.all([
    prisma.fediFollowing.findUnique({ where: { actorUri: resolvedUri }, select: { id: true } }),
    prisma.fediFollower.findUnique({ where: { actorUri: resolvedUri }, select: { id: true } }),
  ]);
  const flags = { followedByMe: !!followedByMe, followsMe: !!followsMe };

  if (knownUri) {
    const profile = await fetchActorProfile(knownUri);
    if (!profile) {
      return NextResponse.json({ error: "could not fetch actor" }, { status: 404 });
    }
    return NextResponse.json({ ...profile, ...flags });
  }

  // Light discovery card (no bio/header/live counts).
  return NextResponse.json({
    ...light,
    headerUrl: null,
    summary: null,
    url: light!.actorUri,
    counts: { followers: null, following: null, posts: null },
    partial: true,
    ...flags,
  });
}
