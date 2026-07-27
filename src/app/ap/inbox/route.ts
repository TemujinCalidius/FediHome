import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverActivity, verifyIncomingSignature, actorMatchesSigner, signedGet } from "@/lib/http-signatures";
import { processAttachments, fetchLinkEmbed } from "@/lib/fedi-media";
import { sanitizeHtml } from "@/lib/sanitize";
import { assertPublicHost } from "@/lib/url-guard";
import { sendPushToOwner } from "@/lib/push";
import { resolveOwnedTarget } from "@/lib/notifications";
import { htmlToText } from "@/lib/html-text";
import { getSiteUrl } from "@/lib/identity";
import { isBlockedSender } from "@/lib/blocks";

const ACTOR_FETCH_TIMEOUT_MS = 8000;
const DEBUG = process.env.FEDIHOME_DEBUG === "true";

/** Escape plain text for safe inclusion in HTML (Article `name` is plain text). */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Friendly display label for a fedi actor, e.g. "Ada" or "@ada@mastodon.social". */
function actorLabel(info: { displayName?: string | null; username: string; domain: string }): string {
  return info.displayName || `@${info.username}@${info.domain}`;
}

/** Push body for a reply: "<actor>: <plain-text snippet>". */
function replyPushBody(
  info: { displayName?: string | null; username: string; domain: string },
  html: string
): string {
  const snippet = htmlToText(html, 120);
  return snippet ? `${actorLabel(info)}: ${snippet}` : `${actorLabel(info)} replied to you`;
}

export async function POST(req: NextRequest) {
  // Read body as text first so we can validate Digest against the actual bytes
  // and reject before parsing (C4).
  const rawBody = await req.text();

  const verification = await verifyIncomingSignature(req, rawBody);
  if (!verification.valid) {
    console.warn(`AP inbox: rejected signature (${verification.reason})`);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let activity;
  try {
    activity = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const type = activity.type;
  const actorUri = typeof activity.actor === "string" ? activity.actor : activity.actor?.id;

  if (!actorUri) {
    return NextResponse.json({ error: "missing actor" }, { status: 400 });
  }

  // C5: bind the verified keyId-derived actor to the claimed activity actor.
  // Otherwise any signer can post follows/likes/boosts attributed to anyone.
  if (!actorMatchesSigner(verification.actorUri, actorUri)) {
    console.warn(
      `AP inbox: keyId/actor mismatch (signer=${verification.actorUri} claimed=${actorUri})`
    );
    return NextResponse.json({ error: "keyId/actor mismatch" }, { status: 401 });
  }

  // Blocked senders are dropped here, after the signature is verified (so the
  // actor is proven) and before ANY handler runs. Blocking used to be a one-shot
  // purge that nothing re-checked, so a blocked account could simply re-follow,
  // re-like and reply again. Returns the usual 202 rather than an error, so the
  // block stays invisible to the sender — see lib/blocks.ts.
  if (await isBlockedSender(actorUri)) {
    if (DEBUG) console.log(`AP inbox: dropped ${type} from blocked ${encodeURIComponent(actorUri)}`);
    return new NextResponse(null, { status: 202 });
  }

  // L1: encode actorUri before logging to prevent log-injection via newlines
  if (DEBUG) console.log(`AP inbox: ${type} from ${encodeURIComponent(actorUri)}`);

  switch (type) {
    case "Follow":
      await handleFollow(actorUri, activity);
      break;

    case "Undo":
      if (activity.object?.type === "Follow") {
        await handleUnfollow(actorUri);
      } else if (activity.object?.type === "Like") {
        await handleUndoLike(actorUri, activity.object);
      } else if (activity.object?.type === "Announce") {
        await handleUndoBoost(actorUri, activity.object);
      }
      break;

    case "Like":
      await handleLike(actorUri, activity);
      break;

    case "Announce": // Boost
      await handleBoost(actorUri, activity);
      break;

    case "Create":
      // Accept Article too — fedihome federates titled posts as Article, and a
      // Note-only gate silently drops them on the receiving instance.
      if (
        activity.object?.type === "Note" ||
        activity.object?.type === "Article"
      ) {
        await handleNote(actorUri, activity.object);
      }
      break;

    case "Update":
      // A remote edit of a Note/Article we may already store (#205). Without
      // this, edits made on the origin instance never apply here.
      if (
        activity.object?.type === "Note" ||
        activity.object?.type === "Article"
      ) {
        await handleUpdateNote(actorUri, activity.object);
      }
      break;

    case "Delete":
      // Handle deletes silently
      break;

    case "Accept":
      // Their server agreed to a Follow we sent (#348). Previously a bare break,
      // so a manually-approved account looked identical to a real follow forever.
      await handleAccept(actorUri, activity);
      break;

    case "Reject":
      // They refused, or revoked an established follow. Previously fell through
      // to `default` and was logged only under FEDIHOME_DEBUG, leaving a row for
      // an account that had explicitly said no.
      await handleReject(actorUri, activity);
      break;

    case "Move":
      // Someone we follow migrated servers (#339). Without this the Move is
      // ignored, our follow stays pointed at the dead account, and their posts
      // simply stop arriving with nothing to explain why.
      await handleMove(actorUri, activity);
      break;

    default:
      if (DEBUG) console.log(`Unhandled ActivityPub activity type: ${type}`);
  }

  return new NextResponse(null, { status: 202 });
}

async function fetchActorInfo(actorUri: string) {
  if (!(await assertPublicHost(actorUri))) return null;
  try {
    const res = await fetch(actorUri, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(ACTOR_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const actor = await res.json();
    const domain = new URL(actorUri).hostname;
    return {
      username: actor.preferredUsername || "unknown",
      domain,
      displayName: actor.name || null,
      avatarUrl: actor.icon?.url || null,
      inbox: actor.inbox,
    };
  } catch {
    return null;
  }
}

async function handleFollow(actorUri: string, activity: Record<string, unknown>) {
  const info = await fetchActorInfo(actorUri);
  if (!info) return;

  // Only a genuinely new follow should buzz the phone (Follow can be redelivered).
  const alreadyFollowing = await prisma.fediFollower.findUnique({ where: { actorUri } });

  // Store follower
  await prisma.fediFollower.upsert({
    where: { actorUri },
    create: {
      actorUri,
      inbox: info.inbox,
      username: info.username,
      domain: info.domain,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
    },
    update: {
      inbox: info.inbox,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
    },
  });

  if (!alreadyFollowing) {
    void sendPushToOwner({
      title: "New follower",
      body: `${actorLabel(info)} followed you`,
      url: "/timeline",
      type: "follow",
      icon: info.avatarUrl || undefined,
    }).catch(() => {});
  }

  // Auto-accept: send signed Accept activity back
  try {
    await deliverActivity(info.inbox, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${getSiteUrl()}/ap/accept/${Date.now()}`,
      type: "Accept",
      actor: `${getSiteUrl()}/ap/actor`,
      object: activity,
    });
  } catch (err) {
    console.error("Failed to send Accept:", err);
  }
}

async function handleUnfollow(actorUri: string) {
  await prisma.fediFollower.delete({ where: { actorUri } }).catch(() => {});
}

/**
 * Strip trailing slashes without a regex.
 *
 * `/\/+$/` looks harmless but backtracks quadratically on a long run of slashes
 * followed by anything else — and these strings come straight out of a REMOTE
 * actor document, so a hostile server could send 100KB of slashes and burn CPU
 * in our inbox. Caught by CodeQL (js/polynomial-redos). A character scan is O(n)
 * and cannot backtrack.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return s.slice(0, end);
}

/** Compare actor ids the way a remote server does — exact, bar a trailing slash. */
function sameActor(a: string, b: string): boolean {
  return stripTrailingSlashes(a) === stripTrailingSlashes(b);
}

/**
 * Fetch an actor for Move verification, including `alsoKnownAs`.
 *
 * Uses `signedGet`, unlike `fetchActorInfo`: an instance running authorized
 * fetch (Mastodon's secure mode) answers an unsigned actor request with 401,
 * and silently failing to verify would mean silently refusing every move from
 * such a server.
 */
async function fetchActorForMove(actorUri: string) {
  if (!(await assertPublicHost(actorUri))) return null;
  try {
    const res = await signedGet(actorUri, ACTOR_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const actor = await res.json();
    const aka = actor.alsoKnownAs;
    return {
      inbox: typeof actor.inbox === "string" ? actor.inbox : null,
      username: actor.preferredUsername || "unknown",
      domain: new URL(actorUri).hostname,
      displayName: actor.name || null,
      avatarUrl: actor.icon?.url || null,
      alsoKnownAs: (Array.isArray(aka) ? aka : aka ? [aka] : []).filter(
        (v: unknown): v is string => typeof v === "string",
      ),
    };
  } catch {
    return null;
  }
}

/**
 * An account we follow moved to a new server.
 *
 * The verification is the entire point. The HTTP signature already proves the
 * OLD account sent this. What it does not prove is that the NEW account agrees —
 * so without checking that the target's `alsoKnownAs` names the origin, a `Move`
 * is an account-hijack primitive: anyone could redirect a follow they don't own
 * to an account they control. Both ends must agree, exactly as Mastodon requires.
 */
async function handleMove(originActorUri: string, activity: Record<string, unknown>) {
  const target =
    typeof activity.target === "string"
      ? activity.target
      : ((activity.target as Record<string, unknown>)?.id as string | undefined);
  if (!target || typeof target !== "string") return;
  if (sameActor(target, originActorUri)) return; // a move to itself is meaningless

  // Only relevant if we actually follow the origin. This also makes redelivery
  // idempotent for free: after a successful move the origin row is gone, so a
  // repeat Move finds nothing and stops here.
  const existing = await prisma.fediFollowing.findUnique({ where: { actorUri: originActorUri } });
  if (!existing) return;

  const targetActor = await fetchActorForMove(target);
  if (!targetActor?.inbox) return;

  // THE check: the destination must claim the origin as one of its own aliases.
  if (!targetActor.alsoKnownAs.some((alias) => sameActor(alias, originActorUri))) {
    console.warn(
      `AP inbox: refused Move ${encodeURIComponent(originActorUri)} -> ${encodeURIComponent(target)} — target does not list it in alsoKnownAs`,
    );
    return;
  }

  // Re-point the follow. Upsert rather than create: we may already follow the
  // destination independently, in which case this just refreshes it.
  await prisma.fediFollowing.upsert({
    where: { actorUri: target },
    create: {
      actorUri: target,
      inbox: targetActor.inbox,
      username: targetActor.username,
      domain: targetActor.domain,
      displayName: targetActor.displayName,
      avatarUrl: targetActor.avatarUrl,
    },
    update: {
      inbox: targetActor.inbox,
      displayName: targetActor.displayName,
      avatarUrl: targetActor.avatarUrl,
    },
  });
  await prisma.fediFollowing.delete({ where: { actorUri: originActorUri } }).catch(() => {});

  // Tell both servers, best-effort. The new one needs a Follow to start
  // delivering; the old one gets an Undo so it stops.
  const followId = `${getSiteUrl()}/ap/follow/${encodeURIComponent(target)}`;
  await deliverActivity(targetActor.inbox, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: followId,
    type: "Follow",
    actor: `${getSiteUrl()}/ap/actor`,
    object: target,
  }).catch(() => {});
  if (existing.inbox) {
    await deliverActivity(existing.inbox, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${getSiteUrl()}/ap/undo/${encodeURIComponent(originActorUri)}`,
      type: "Undo",
      actor: `${getSiteUrl()}/ap/actor`,
      object: {
        type: "Follow",
        actor: `${getSiteUrl()}/ap/actor`,
        object: originActorUri,
      },
    }).catch(() => {});
  }

  const label = targetActor.displayName || `@${targetActor.username}@${targetActor.domain}`;
  void sendPushToOwner({
    title: "Someone you follow moved",
    body: `${existing.displayName || `@${existing.username}@${existing.domain}`} is now ${label} — your follow moved with them.`,
    url: "/timeline",
    type: "move",
    icon: targetActor.avatarUrl || undefined,
  }).catch(() => {});
}

/**
 * Is `object` OUR `Follow` of `actorUri`?
 *
 * We cannot match on the Follow's id: `follow()` mints
 * `${siteUrl}/ap/follow/${Date.now()}` and never persists it, so there is
 * nothing to compare against. Match on the actor pair instead — the signature
 * has already bound `activity.actor` by the time we get here, so the remaining
 * job is proving the wrapped Follow is ours and is about them.
 *
 * Both shapes are legal and both occur in the wild: Mastodon/Akkoma/GoToSocial
 * embed the whole Follow, others send just its id string.
 */
function isOurFollowOf(object: unknown, actorUri: string): boolean {
  const us = `${getSiteUrl()}/ap/actor`;

  // Bare id: nothing is recoverable but our own id namespace. `Date.now()` is
  // guessable, but the signature already binds the sender, so the most an
  // attacker achieves is flipping their OWN row — which their real Accept does.
  if (typeof object === "string") return object.startsWith(`${getSiteUrl()}/ap/follow/`);

  if (!object || typeof object !== "object") return false;
  const o = object as Record<string, unknown>;

  // Present-and-wrong is a refusal; absent is tolerated (not every server sends it).
  if (typeof o.type === "string" && o.type !== "Follow") return false;
  // The load-bearing check: an Accept carrying somebody else's Follow isn't ours.
  if (typeof o.actor !== "string" || !sameActor(o.actor, us)) return false;
  // Server A must not accept a Follow addressed to server B.
  if (typeof o.object === "string" && !sameActor(o.object, actorUri)) return false;
  if (typeof o.id === "string" && !o.id.startsWith(getSiteUrl())) return false;
  return true;
}

/** `Accept(Follow)` — mark the follow as agreed (#348). */
async function handleAccept(actorUri: string, activity: Record<string, unknown>) {
  if (!isOurFollowOf(activity.object, actorUri)) return;

  // updateMany, NEVER upsert: an Accept from an account we don't follow must not
  // be able to conjure a following row. It also makes redelivery a no-op for free.
  const { count } = await prisma.fediFollowing.updateMany({
    where: { actorUri, accepted: false },
    data: { accepted: true },
  });
  if (DEBUG && count > 0) console.log(`AP inbox: follow accepted by ${encodeURIComponent(actorUri)}`);
}

/** `Reject(Follow)` — drop the follow and tell the owner (#348). */
async function handleReject(actorUri: string, activity: Record<string, unknown>) {
  if (!isOurFollowOf(activity.object, actorUri)) return;

  // Delete regardless of `accepted`: Mastodon also sends Reject to REVOKE an
  // established follow when someone removes a follower, and keeping the row would
  // leave a follow that no longer exists published in /ap/following.
  const { count } = await prisma.fediFollowing.deleteMany({ where: { actorUri } });

  // No row means we never followed them, so there is nothing to report. This is
  // the anti-spam guard: only a follow the owner personally initiated can raise
  // an alert, so a hostile instance cannot manufacture them.
  if (count === 0) return;

  const info = await fetchActorInfo(actorUri).catch(() => null);
  const label = info ? actorLabel(info) : actorUri;

  // No Notification model exists — computeNotifications() unions read-time
  // sources, and MaintenanceItem is the only durable owner-facing channel for a
  // system event. Same idiom as flagKeyRegeneration(): `update: {}` so a
  // dismissed alert is never resurrected. The actor URI goes in `packageName` so
  // distinct rejections stay distinct rows while repeats collapse into one.
  await prisma.maintenanceItem
    .upsert({
      where: {
        kind_packageName_latest: { kind: "federation", packageName: actorUri, latest: "follow-rejected" },
      },
      update: {},
      create: {
        kind: "federation",
        packageName: actorUri,
        latest: "follow-rejected",
        severity: "info",
        title: `${label} declined your follow request`,
        description:
          "Their server sent a Reject, so the follow has been removed from your Following list. " +
          "Some accounts approve followers by hand and may have simply declined; others reject " +
          "everything automatically. You can try following again if you think it was a mistake.",
        url: actorUri,
      },
    })
    .catch(() => {
      /* alerting must never break inbox delivery */
    });
}

async function handleLike(actorUri: string, activity: Record<string, unknown>) {
  const targetApId = typeof activity.object === "string"
    ? activity.object
    : (activity.object as Record<string, unknown>)?.id as string;

  if (!targetApId) return;

  // Ownership gate (#103): only record + notify a Like on OUR content. The bell
  // lists interactions on owned targets only, so an ungated Like on a feed post
  // we don't own would fire a push and climb the app badge while never showing
  // in the bell. `resolveOwnedTarget` is the same ownership test the bell uses.
  const target = await resolveOwnedTarget(targetApId);
  if (!target) return;

  // Idempotency guard (#118): a Like is unique per (actor, target) — an actor
  // can only like a post once, and re-liking after an un-like makes a fresh row
  // (the Undo deleted the old one). So a redelivered Like (AP retries /
  // shared-inbox fan-out) must be a no-op, not a second row (→ duplicate bell),
  // a double-incremented count, and a duplicate push. Enforced in app code, not
  // a DB unique constraint, since `prisma db push` won't add one flaglessly
  // (see the reply guard, #121).
  const existingLike = await prisma.fediInteraction.findFirst({
    where: { actorUri, targetApId, type: "like" },
    select: { id: true },
  });
  if (existingLike) return;

  const info = await fetchActorInfo(actorUri);
  if (!info) return;

  await prisma.fediInteraction.create({
    data: {
      type: "like",
      actorUri,
      targetApId,
      username: info.username,
      domain: info.domain,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
    },
  });

  // Increment like count on post/photo
  await prisma.post.updateMany({
    where: { apId: targetApId },
    data: { likeCount: { increment: 1 } },
  });
  await prisma.photo.updateMany({
    where: { apId: targetApId },
    data: { likeCount: { increment: 1 } },
  });

  void sendPushToOwner({
    title: "New like",
    body: `${actorLabel(info)} liked your post`,
    url: target.url,
    type: "like",
    icon: info.avatarUrl || undefined,
  }).catch(() => {});
}

async function handleUndoLike(actorUri: string, likeActivity: Record<string, unknown>) {
  const targetApId = typeof likeActivity.object === "string"
    ? likeActivity.object
    : (likeActivity.object as Record<string, unknown>)?.id as string;

  if (!targetApId) return;

  const deleted = await prisma.fediInteraction.deleteMany({
    where: { actorUri, targetApId, type: "like" },
  });

  if (deleted.count > 0) {
    await prisma.post.updateMany({
      where: { apId: targetApId },
      data: { likeCount: { decrement: 1 } },
    });
    await prisma.photo.updateMany({
      where: { apId: targetApId },
      data: { likeCount: { decrement: 1 } },
    });
  }
}

async function handleUndoBoost(actorUri: string, announceActivity: Record<string, unknown>) {
  const targetApId = typeof announceActivity.object === "string"
    ? announceActivity.object
    : (announceActivity.object as Record<string, unknown>)?.id as string;

  if (!targetApId) return;

  const deleted = await prisma.fediInteraction.deleteMany({
    where: { actorUri, targetApId, type: "boost" },
  });

  if (deleted.count > 0) {
    await prisma.post.updateMany({
      where: { apId: targetApId },
      data: { boostCount: { decrement: 1 } },
    });
    await prisma.photo.updateMany({
      where: { apId: targetApId },
      data: { boostCount: { decrement: 1 } },
    });
  }

  // Drop the stored boosted post from our feed (handleBoost stores it for
  // followed boosters under this synthetic apId).
  await prisma.fediPost
    .deleteMany({ where: { apId: `boost:${actorUri}:${targetApId}` } })
    .catch(() => {});
}

async function handleBoost(actorUri: string, activity: Record<string, unknown>) {
  const targetApId = typeof activity.object === "string"
    ? activity.object
    : (activity.object as Record<string, unknown>)?.id as string;

  if (!targetApId) return;

  // Idempotency guard (#118): a boost is unique per (actor, target). Only record
  // the interaction / bump the count / push for a not-already-seen boost, so a
  // redelivered Announce (AP retries / shared-inbox fan-out) doesn't create a
  // second row (→ duplicate bell), double-increment the count, or re-notify.
  // We still fall through to the feed-store block below — it has its own dedup
  // and a redelivery can complete a remote fetch an earlier delivery missed.
  const alreadyBoosted = await prisma.fediInteraction.findFirst({
    where: { actorUri, targetApId, type: "boost" },
    select: { id: true },
  });

  const info = await fetchActorInfo(actorUri);
  if (!info) return;

  // Ownership gate (#103): only record the interaction / bump the count / push
  // when the boosted post is OURS — an ungated boost of a non-owned feed post
  // would fire a push and climb the app badge while never showing in the bell.
  // The feed-store block below still runs regardless: a followed account's boost
  // of someone else's post is feed content, not a notification. (`ownedTarget` is
  // null on a redelivered boost too, so we skip the lookup entirely then — #118.)
  const ownedTarget = alreadyBoosted ? null : await resolveOwnedTarget(targetApId);
  if (ownedTarget) {
    // Record interaction and increment counters (existing behavior)
    await prisma.fediInteraction.create({
      data: {
        type: "boost",
        actorUri,
        targetApId,
        username: info.username,
        domain: info.domain,
        displayName: info.displayName,
        avatarUrl: info.avatarUrl,
      },
    });

    await prisma.post.updateMany({
      where: { apId: targetApId },
      data: { boostCount: { increment: 1 } },
    });
    await prisma.photo.updateMany({
      where: { apId: targetApId },
      data: { boostCount: { increment: 1 } },
    });

    void sendPushToOwner({
      title: "New boost",
      body: `${actorLabel(info)} boosted your post`,
      url: ownedTarget.url,
      type: "boost",
      icon: info.avatarUrl || undefined,
    }).catch(() => {});
  }

  // If the booster is someone we follow, store the boosted post for our feed
  const isFollowed = await prisma.fediFollowing.findUnique({ where: { actorUri } });
  if (!isFollowed) return;

  // Check if we already have this boost stored
  const boostApId = `boost:${actorUri}:${targetApId}`;
  const existing = await prisma.fediPost.findUnique({ where: { apId: boostApId } });
  if (existing) return;

  // Fetch the original post from the remote server
  if (!(await assertPublicHost(targetApId))) return;
  try {
    const res = await fetch(targetApId, {
      headers: { Accept: "application/activity+json, application/ld+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const note = await res.json();
    if (note.type !== "Note" && note.type !== "Article") return;

    const originalActorUri = typeof note.attributedTo === "string"
      ? note.attributedTo
      : note.attributedTo?.id;

    // The block check at the top of the inbox only covers the SENDER — here
    // that's the booster, who isn't blocked. Without this, someone you follow
    // boosting a blocked person's post puts that person's content, name and
    // avatar straight back into your feed, under their own actorUri. Blocking
    // purges their posts, so silently re-creating them is exactly the
    // "one-shot purge, not a block" failure this is all meant to close.
    if (originalActorUri && (await isBlockedSender(originalActorUri))) return;

    const originalInfo = originalActorUri ? await fetchActorInfo(originalActorUri) : null;

    const boostTitle = typeof note.name === "string" ? note.name.trim() : "";
    const boostBody = (note.content as string) || "";
    const content = sanitizeHtml(
      boostTitle ? `<h2>${escapeText(boostTitle)}</h2>${boostBody}` : boostBody
    );
    const { urls: mediaUrls, types: mediaTypes } = await processAttachments(
      note.attachment as unknown[] | undefined
    );
    const embed = await fetchLinkEmbed(content);

    await prisma.fediPost.create({
      data: {
        actorUri: originalActorUri || actorUri,
        apId: boostApId,
        content,
        contentHtml: content,
        mediaUrls,
        mediaTypes,
        username: originalInfo?.username || "unknown",
        domain: originalInfo?.domain || new URL(targetApId).hostname,
        displayName: originalInfo?.displayName,
        avatarUrl: originalInfo?.avatarUrl,
        boostedBy: actorUri,
        boostedByName: info.displayName || `${info.username}@${info.domain}`,
        publishedAt: new Date(), // boost time, not original post time
        embedUrl: embed?.url || null,
        embedTitle: embed?.title || null,
        embedDescription: embed?.description || null,
        embedImage: embed?.image || null,
        embedSiteName: embed?.siteName || null,
      },
    });
  } catch {
    // Failed to fetch original post — skip silently
  }
}

/**
 * Record an incoming reply to our content as a FediInteraction and buzz the
 * owner — de-duplicated on the reply Note's own apId so a redelivered
 * `Create(Note)` (AP retries / shared-inbox fan-out) doesn't create a second
 * bell entry or fire a second push. A reply has no counter to desync (unlike
 * like/boost), so redelivery's only symptom is the duplicate notification.
 *
 * The note's own apId is the right key: keying on (actorUri, targetApId) like
 * like/boost would wrongly collapse *distinct* replies from the same person to
 * the same post. A Note with no id keeps the old behaviour (no key → no dedup).
 *
 * Dedup is enforced here in app code rather than via a DB unique constraint:
 * AP redelivery is sequential (retries are spaced out), so by the time a
 * redelivery arrives the first row is committed and the lookup below finds it.
 * (`prisma db push` — FediHome's upgrade path — refuses to add a unique index
 * without --accept-data-loss, which would break `npm run update` for everyone.)
 */
async function recordIncomingReply(opts: {
  noteApId: string | null;
  actorUri: string;
  targetApId: string;
  content: string; // stored on the FediInteraction (sanitized note body)
  pushBodyHtml: string; // rendered into the push body
  info: { displayName?: string | null; username: string; domain: string; avatarUrl: string | null };
}): Promise<void> {
  const { noteApId, actorUri, targetApId, content, pushBodyHtml, info } = opts;

  // Redelivery guard: skip the row + push if we've already recorded this exact
  // reply. Only when we have an apId — querying `sourceApId: null` would match
  // every other null-keyed (like/boost) row.
  if (noteApId) {
    const already = await prisma.fediInteraction.findFirst({
      where: { sourceApId: noteApId },
      select: { id: true },
    });
    if (already) return;
  }

  // No try/catch: a genuine write failure should propagate (the inbox 500s and
  // the sender retries) rather than be silently swallowed into a 202 that drops
  // the reply.
  await prisma.fediInteraction.create({
    data: {
      type: "reply",
      actorUri,
      targetApId,
      sourceApId: noteApId,
      content,
      username: info.username,
      domain: info.domain,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
    },
  });

  void sendPushToOwner({
    title: "New reply",
    body: replyPushBody(info, pushBodyHtml),
    url: "/timeline",
    type: "reply",
    icon: info.avatarUrl || undefined,
  }).catch(() => {});
}

/**
 * Incoming `Update(Note|Article)` — a remote edit of content we already store
 * (#205). Re-derives the stored content exactly like `handleNote` (title
 * escape + sanitizeHtml + attachments) and stamps `editedAt`. An object we
 * never stored is ignored (matching Mastodon: no create-from-Update).
 *
 * Ownership gate: the HTTP signature + actorMatchesSigner bind the request to
 * the actor's HOST, not the actor — so we additionally require the Update's
 * actor to BE the stored author, or any signed actor on the same host could
 * rewrite our cached copy of someone else's post.
 */
async function handleUpdateNote(actorUri: string, note: Record<string, unknown>) {
  const apId = (note.id as string) || "";
  if (!apId) return;

  const stored = await prisma.fediPost.findUnique({ where: { apId } });

  if (stored && stored.actorUri !== actorUri) {
    console.warn(
      `AP inbox: Update actor mismatch (actor=${encodeURIComponent(actorUri)} stored=${encodeURIComponent(stored.actorUri)})`
    );
    return;
  }

  // Mastodon sends the edit time as `updated`; fall back to "now". Clamp to
  // <= now — the value is remote-controlled, and a future-dated edit stamp
  // shouldn't be trustable by anything that later displays or sorts on it.
  const now = new Date();
  const updatedRaw = note.updated ? new Date(note.updated as string) : now;
  const editedAt = isNaN(updatedRaw.getTime()) || updatedRaw > now ? now : updatedRaw;

  if (stored) {
    const { urls: mediaUrls, types: mediaTypes } = await processAttachments(
      note.attachment as unknown[] | undefined
    );
    const articleTitle = typeof note.name === "string" ? note.name.trim() : "";
    const body = (note.content as string) || "";
    const rawContent = articleTitle
      ? `<h2>${escapeText(articleTitle)}</h2>${body}`
      : body;
    const content = sanitizeHtml(rawContent);

    await prisma.fediPost.update({
      where: { apId },
      data: { content, contentHtml: content, mediaUrls, mediaTypes, editedAt },
    });
    if (DEBUG) console.log(`AP inbox: applied Update to ${encodeURIComponent(apId)}`);
  }

  // An edited reply to OUR content also lives in FediInteraction rows (the
  // bell/thread copy) — and for non-followed repliers that's the ONLY copy.
  // sourceApId isn't unique, so updateMany; the actorUri filter keeps the
  // ownership gate on this path too.
  await prisma.fediInteraction.updateMany({
    where: { sourceApId: apId, actorUri, type: "reply" },
    data: { content: sanitizeHtml((note.content as string) || "") },
  });
}

async function handleNote(actorUri: string, note: Record<string, unknown>) {
  const inReplyTo = (note.inReplyTo as string) || null;

  const info = await fetchActorInfo(actorUri);
  if (!info) return;

  // Check if this is a DM (direct message to us, not public)
  const toList = Array.isArray(note.to) ? note.to as string[] : [note.to as string].filter(Boolean);
  const ccList = Array.isArray(note.cc) ? note.cc as string[] : [note.cc as string].filter(Boolean);
  const isPublic = [...toList, ...ccList].includes("https://www.w3.org/ns/activitystreams#Public");
  const isDirectToUs = toList.includes(`${getSiteUrl()}/ap/actor`) && !isPublic;

  if (isDirectToUs) {
    // Store as a direct message
    const dmApId = (note.id as string) || `dm-${Date.now()}`;
    const dmExisted = await prisma.directMessage.findUnique({ where: { apId: dmApId } });
    await prisma.directMessage.upsert({
      where: { apId: dmApId },
      create: {
        source: "fedi",
        senderUri: actorUri,
        senderHandle: `@${info.username}@${info.domain}`,
        senderName: info.displayName,
        senderAvatar: info.avatarUrl,
        content: (note.content as string) || "",
        contentHtml: sanitizeHtml((note.content as string) || ""),
        apId: (note.id as string) || null,
        conversationKey: `fedi:${actorUri}`,
        createdAt: note.published ? new Date(note.published as string) : new Date(),
      },
      update: {},
    });
    if (DEBUG) console.log(`AP inbox: DM from ${info.username}@${info.domain}`);
    if (!dmExisted) {
      void sendPushToOwner({
        title: "New message",
        body: `${actorLabel(info)} sent you a message`,
        url: "/timeline",
        type: "dm",
        icon: info.avatarUrl || undefined,
      }).catch(() => {});
    }
    return;
  }

  // Check if this person is someone we follow
  const isFollowed = await prisma.fediFollowing.findUnique({
    where: { actorUri },
  });

  // Their server is delivering to us, so the Follow plainly landed even if the
  // Accept never did — plenty of implementations never send one (#348). Without
  // this, those follows would read "pending" forever.
  if (isFollowed && !isFollowed.accepted) {
    await prisma.fediFollowing
      .updateMany({ where: { actorUri, accepted: false }, data: { accepted: true } })
      .catch(() => {});
  }

  if (isFollowed) {
    // Store as FediPost for timeline (both top-level and replies from followed accounts)
    const { urls: mediaUrls, types: mediaTypes } = await processAttachments(
      note.attachment as unknown[] | undefined
    );

    // Titled posts arrive as Articles; the FediPost schema has no title column,
    // so preserve the title as a heading. `name` is plain text — HTML-escape it
    // before wrapping, and sanitizeHtml re-validates the result.
    const articleTitle = typeof note.name === "string" ? note.name.trim() : "";
    const body = (note.content as string) || "";
    const rawContent = articleTitle
      ? `<h2>${escapeText(articleTitle)}</h2>${body}`
      : body;
    const content = sanitizeHtml(rawContent);
    const embed = await fetchLinkEmbed(rawContent);
    const conversationId =
      (note.conversation as string) ||
      (note.context as string) ||
      inReplyTo ||
      (note.id as string) ||
      null;

    await prisma.fediPost.upsert({
      where: { apId: (note.id as string) || "" },
      create: {
        actorUri,
        apId: (note.id as string) || `unknown-${Date.now()}`,
        content,
        contentHtml: content,
        mediaUrls,
        mediaTypes,
        inReplyTo,
        conversationId,
        embedUrl: embed?.url || null,
        embedTitle: embed?.title || null,
        embedDescription: embed?.description || null,
        embedImage: embed?.image || null,
        embedSiteName: embed?.siteName || null,
        username: info.username,
        domain: info.domain,
        displayName: info.displayName,
        avatarUrl: info.avatarUrl,
        publishedAt: note.published
          ? new Date(note.published as string)
          : new Date(),
      },
      update: {},
    });

    // Also record as FediInteraction if replying to one of OUR posts or replies
    if (inReplyTo) {
      const isOurPost =
        (await prisma.post.findFirst({ where: { apId: inReplyTo } })) ||
        (await prisma.photo.findFirst({ where: { apId: inReplyTo } })) ||
        (await prisma.fediPost.findFirst({ where: { apId: inReplyTo, isOutgoing: true } }));
      if (isOurPost) {
        await recordIncomingReply({
          noteApId: (note.id as string) || null,
          actorUri,
          targetApId: inReplyTo,
          content: sanitizeHtml((note.content as string) || ""),
          pushBodyHtml: content,
          info,
        });
      }
    }
  } else if (inReplyTo) {
    // Not followed — only store if replying to our content (posts, photos, or our replies)
    const isOurContent =
      (await prisma.post.findFirst({ where: { apId: inReplyTo } })) ||
      (await prisma.photo.findFirst({ where: { apId: inReplyTo } })) ||
      (await prisma.fediPost.findFirst({ where: { apId: inReplyTo, isOutgoing: true } }));
    if (!isOurContent) return;
    const replyHtml = sanitizeHtml((note.content as string) || "");
    await recordIncomingReply({
      noteApId: (note.id as string) || null,
      actorUri,
      targetApId: inReplyTo,
      content: replyHtml,
      pushBodyHtml: replyHtml,
      info,
    });
  }
}
