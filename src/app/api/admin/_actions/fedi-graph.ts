import { NextResponse } from "next/server";
import { normalizeDomain } from "@/lib/blocks";
import { prisma } from "@/lib/db";
import { deliverActivity } from "@/lib/http-signatures";
import { processAttachments, fetchLinkEmbed } from "@/lib/fedi-media";
import { assertPublicHost, isPrivateUrl } from "@/lib/url-guard";
import { sanitizeHtml } from "@/lib/sanitize";
import type { AdminBody } from "./types";
import { getSiteUrl, getIdentity } from "@/lib/identity";

const REMOTE_FETCH_TIMEOUT_MS = 8000;

export async function follow(body: AdminBody): Promise<NextResponse> {
  const { handle } = body;
  // Follow by actor URI when the caller already has one (a reply's author, a
  // liker, a boost). WebFinger only exists to turn a handle INTO an actor URI,
  // so when we already hold the real one — the exact string the remote server
  // published — going back through a handle would be a lossy round-trip, and
  // relies on rebuilding a handle we may not have.
  const directActorUri = typeof body.actorUri === "string" ? body.actorUri.trim() : "";

  let username = "";
  let domain = "";

  if (directActorUri) {
    let parsed: URL;
    try {
      parsed = new URL(directActorUri);
    } catch {
      return NextResponse.json({ error: "Invalid actor URI" }, { status: 400 });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return NextResponse.json({ error: "Invalid actor URI" }, { status: 400 });
    }
    domain = parsed.host;
    // Provisional; the actor's own preferredUsername wins once fetched.
    username = parsed.pathname.split("/").filter(Boolean).pop() || "";
  } else {
    // Parse handle: @user@domain or user@domain
    const cleaned = (handle || "").replace(/^@/, "");
    [username, domain] = cleaned.split("@");

    if (!username || !domain) {
      return NextResponse.json(
        { error: "Invalid handle format. Use @user@domain" },
        { status: 400 }
      );
    }
  }

  // Refuse to follow someone who is blocked. Otherwise the backfill below
  // re-imports up to 10 of their posts into the feed while the block is still
  // in place — an incoherent state where the block list shows them blocked, the
  // inbox drops everything they send, and their content is on screen anyway.
  // It also matters for scopes: `follow` needs only `interact`, while `unblock`
  // needs `manage`, so without this an interact-scoped token could undo the
  // visible effect of a block it has no authority to lift.
  if (directActorUri) {
    const blocked = await prisma.blockedActor.findUnique({
      where: { actorUri: directActorUri },
      select: { id: true },
    });
    if (blocked) {
      return NextResponse.json(
        { error: "You've blocked this account. Unblock them first if you want to follow them." },
        { status: 409 },
      );
    }
  }

  // Discover actor via WebFinger
  try {
    let actorLink: { href: string };

    if (directActorUri) {
      // Same SSRF guard the WebFinger path applies to the URL it discovers.
      if (!(await assertPublicHost(directActorUri))) {
        throw new Error("blocked: actor URL resolves to private host");
      }
      actorLink = { href: directActorUri };
    } else {
      // Validate domain — same character set we'd accept from a Mastodon handle.
      if (!/^[a-z0-9.-]+$/i.test(domain) || domain.includes("..")) {
        throw new Error("invalid domain");
      }
      const wfUrl = `https://${domain}/.well-known/webfinger?resource=acct:${encodeURIComponent(username)}@${encodeURIComponent(domain)}`;
      if (isPrivateUrl(wfUrl)) throw new Error("blocked: private host");
      const wfRes = await fetch(wfUrl, {
        headers: { Accept: "application/jrd+json" },
        signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
      });
      if (!wfRes.ok) throw new Error("WebFinger failed");

      const wfData = await wfRes.json();
      const found = wfData.links?.find(
        (l: { rel: string; type?: string }) =>
          l.rel === "self" && l.type === "application/activity+json"
      );

      if (!found?.href) throw new Error("No actor link found");
      // H8: a malicious WebFinger response could point us at internal services.
      // Use assertPublicHost (DNS-resolves) so a rebinding hostname is caught.
      if (!(await assertPublicHost(found.href))) {
        throw new Error("blocked: actor URL resolves to private host");
      }
      actorLink = found;
    }

    // Authoritative block check, now that WebFinger has told us the real actor
    // URI. The early check above only sees a caller-supplied URI; following by
    // HANDLE resolves to the actor URI here, so a blocked account could
    // otherwise be followed simply by typing their @handle instead.
    const blockedActor = await prisma.blockedActor.findUnique({
      where: { actorUri: actorLink.href },
      select: { id: true },
    });
    if (blockedActor) {
      return NextResponse.json(
        { error: "You've blocked this account. Unblock them first if you want to follow them." },
        { status: 409 },
      );
    }

    // Fetch actor profile
    const actorRes = await fetch(actorLink.href, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
    });
    if (!actorRes.ok) throw new Error("Actor fetch failed");

    const actor = await actorRes.json();
    // H8: the actor's own claimed inbox/outbox could point at internal services.
    if (typeof actor.inbox !== "string" || !(await assertPublicHost(actor.inbox))) {
      throw new Error("blocked: actor inbox resolves to private host");
    }
    if (actor.outbox && (typeof actor.outbox !== "string" || !(await assertPublicHost(actor.outbox)))) {
      throw new Error("blocked: actor outbox resolves to private host");
    }

    // Store following record. `accepted: false` until their server says otherwise
    // (#348) — the row exists from the moment we send the Follow, which is not
    // the same thing as them having agreed to it.
    await prisma.fediFollowing.upsert({
      where: { actorUri: actorLink.href },
      create: {
        actorUri: actorLink.href,
        inbox: actor.inbox,
        username: actor.preferredUsername || username,
        domain,
        displayName: actor.name || null,
        avatarUrl: actor.icon?.url || null,
        accepted: false,
      },
      update: {
        displayName: actor.name || null,
        avatarUrl: actor.icon?.url || null,
      },
    });

    // Pull recent posts from their outbox
    if (actor.outbox) {
      try {
        const outboxRes = await fetch(actor.outbox, {
          headers: { Accept: "application/activity+json" },
          signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
        });
        if (outboxRes.ok) {
          const outbox = await outboxRes.json();
          const items = outbox.orderedItems || outbox.items || [];
          for (const item of items.slice(0, 10)) {
            const note = item.type === "Create" ? item.object : item;
            if (!note?.id || !note?.content) continue;

            const { urls: mediaUrls, types: mediaTypes } =
              await processAttachments(note.attachment);
            const safeContent = sanitizeHtml(note.content || "");
            const embed = await fetchLinkEmbed(safeContent);
            const inReplyTo = (note.inReplyTo as string) || null;
            const conversationId =
              note.conversation || note.context || inReplyTo || note.id || null;

            await prisma.fediPost.upsert({
              where: { apId: note.id },
              create: {
                actorUri: actorLink.href,
                apId: note.id,
                content: safeContent,
                contentHtml: safeContent,
                mediaUrls,
                mediaTypes,
                inReplyTo,
                conversationId,
                embedUrl: embed?.url || null,
                embedTitle: embed?.title || null,
                embedDescription: embed?.description || null,
                embedImage: embed?.image || null,
                embedSiteName: embed?.siteName || null,
                username: actor.preferredUsername || username,
                domain,
                displayName: actor.name || null,
                avatarUrl: actor.icon?.url || null,
                publishedAt: note.published ? new Date(note.published) : new Date(),
              },
              update: {},
            });
          }
        }
      } catch (err) {
        console.error("Failed to fetch outbox:", err);
      }
    }

    // Send signed Follow activity
    await deliverActivity(actor.inbox, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${getSiteUrl()}/ap/follow/${Date.now()}`,
      type: "Follow",
      actor: `${getSiteUrl()}/ap/actor`,
      object: actorLink.href,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to follow: ${err}` },
      { status: 400 }
    );
  }
}

export async function unfollow(body: AdminBody): Promise<NextResponse> {
  const { followingId } = body;
  const record = await prisma.fediFollowing.findUnique({
    where: { id: followingId },
  });

  if (record) {
    // Send signed Undo Follow
    try {
      await deliverActivity(record.inbox, {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${getSiteUrl()}/ap/undo/${Date.now()}`,
        type: "Undo",
        actor: `${getSiteUrl()}/ap/actor`,
        object: {
          type: "Follow",
          actor: `${getSiteUrl()}/ap/actor`,
          object: record.actorUri,
        },
      });
    } catch {
      // Continue even if undo delivery fails
    }

    await prisma.fediFollowing.delete({ where: { id: followingId } });
  }

  return NextResponse.json({ success: true });
}

export async function unfollowByUri(body: AdminBody): Promise<NextResponse> {
  const { actorUri: unfollowUri } = body;
  if (!unfollowUri) {
    return NextResponse.json({ error: "actorUri required" }, { status: 400 });
  }
  const record = await prisma.fediFollowing.findUnique({ where: { actorUri: unfollowUri } });
  if (record) {
    try {
      await deliverActivity(record.inbox, {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${getSiteUrl()}/ap/undo/${Date.now()}`,
        type: "Undo",
        actor: `${getSiteUrl()}/ap/actor`,
        object: {
          type: "Follow",
          actor: `${getSiteUrl()}/ap/actor`,
          object: unfollowUri,
        },
      });
    } catch {
      // Continue
    }
    await prisma.fediFollowing.delete({ where: { actorUri: unfollowUri } });
  }
  return NextResponse.json({ success: true });
}

export async function block(body: AdminBody): Promise<NextResponse> {
  // Block a fedi user — unfollow, remove their posts, prevent future content
  const { actorUri } = body;
  if (!actorUri) {
    return NextResponse.json({ error: "actorUri required" }, { status: 400 });
  }

  // Unfollow if following
  const followRecord = await prisma.fediFollowing.findUnique({
    where: { actorUri },
  });
  if (followRecord) {
    try {
      await deliverActivity(followRecord.inbox, {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${getSiteUrl()}/ap/undo/${Date.now()}`,
        type: "Undo",
        actor: `${getSiteUrl()}/ap/actor`,
        object: {
          type: "Follow",
          actor: `${getSiteUrl()}/ap/actor`,
          object: actorUri,
        },
      });
    } catch {
      // Continue even if delivery fails
    }
    await prisma.fediFollowing.delete({ where: { actorUri } });
  }

  // Drop them as a follower. We deliberately DON'T federate a Block activity:
  // ActivityPub says a server SHOULD NOT deliver Block to its object, so the
  // blocked person can't tell. Mastodon sends it anyway, which is why blocked
  // users there can detect a block. Enforcement is local instead — the inbox
  // now drops everything from a blocked actor (lib/blocks.ts), which achieves
  // the same result without notifying them.
  const follower = await prisma.fediFollower.findUnique({ where: { actorUri } });
  if (follower) {
    await prisma.fediFollower.delete({ where: { actorUri } });
  }

  // Capture display info (from a follow/follower record, else a stored post)
  // BEFORE purging content, so the block list can show a name/avatar.
  const info =
    follower ??
    followRecord ??
    (await prisma.fediPost.findFirst({
      where: { actorUri },
      select: { username: true, domain: true, displayName: true, avatarUrl: true },
    }));

  // Delete all their posts from our timeline
  await prisma.fediPost.deleteMany({ where: { actorUri } });

  // Their likes/boosts are cached as counters on the post as well as rows in
  // FediInteraction, so deleting the rows alone leaves the number wrong — a post
  // reading "3 likes" while showing two faces, permanently. And it can't
  // self-correct: an Undo(Like) from a blocked actor is now dropped at the
  // inbox, so nothing will ever decrement it. Read the rows first, then take the
  // counters down with them.
  const theirInteractions = await prisma.fediInteraction.findMany({
    where: { actorUri, type: { in: ["like", "boost"] } },
    select: { type: true, targetApId: true },
  });

  await prisma.fediInteraction.deleteMany({ where: { actorUri } });

  for (const it of theirInteractions) {
    // Floor at zero: a counter can already be out of step with the rows (a
    // pre-#118 duplicate, a manual edit), and a negative count renders worse
    // than a stale one.
    const where =
      it.type === "like"
        ? { apId: it.targetApId, likeCount: { gt: 0 } }
        : { apId: it.targetApId, boostCount: { gt: 0 } };
    const data =
      it.type === "like"
        ? { likeCount: { decrement: 1 } }
        : { boostCount: { decrement: 1 } };
    await prisma.post.updateMany({ where, data }).catch(() => {});
    await prisma.photo.updateMany({ where, data }).catch(() => {});
  }

  // Record the block so it's listable + reversible (#180).
  await prisma.blockedActor
    .upsert({
      where: { actorUri },
      create: {
        actorUri,
        handle: info ? `@${info.username}@${info.domain}` : null,
        displayName: info?.displayName ?? null,
        avatarUrl: info?.avatarUrl ?? null,
        inbox: follower?.inbox ?? followRecord?.inbox ?? null,
      },
      update: {},
    })
    .catch(() => {});

  return NextResponse.json({ success: true });
}

export async function unblock(body: AdminBody): Promise<NextResponse> {
  const { actorUri } = body;
  if (!actorUri || typeof actorUri !== "string") {
    return NextResponse.json({ error: "actorUri required" }, { status: 400 });
  }

  // No Undo(Block) is federated, because no Block is federated either — blocks
  // are local-only now, so there is nothing on the remote side to undo. Sending
  // one would also announce "you were blocked, and now you aren't", which is
  // exactly the disclosure keeping blocks local is meant to avoid.
  await prisma.blockedActor.deleteMany({ where: { actorUri } });
  return NextResponse.json({ success: true });
}

/**
 * Block an entire instance.
 *
 * Blocking individuals works until the same server produces ten more of them.
 * A domain block drops everything from that host (and its subdomains — a server
 * handing out subdomains could otherwise sidestep it endlessly) and purges what
 * it has already sent us.
 *
 * Local-only, like actor blocks: nothing is federated, so the instance is never
 * told.
 */
export async function blockDomain(body: AdminBody): Promise<NextResponse> {
  const domain = normalizeDomain(typeof body.domain === "string" ? body.domain : "");
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return NextResponse.json({ error: "Enter a domain, e.g. spam.example" }, { status: 400 });
  }

  // Refuse to block ourselves — it would drop our own federated traffic and
  // there is no obvious way to notice why everything stopped working.
  if (domain === normalizeDomain(getIdentity().fediDomain) || domain === normalizeDomain(getSiteUrl())) {
    return NextResponse.json({ error: "That's this site's own domain." }, { status: 400 });
  }

  const reason =
    typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;

  await prisma.blockedDomain.upsert({
    where: { domain },
    create: { domain, reason },
    update: { reason },
  });

  // Purge what they've already sent. `endsWith` covers subdomains the same way
  // the inbox check does.
  const suffix = `.${domain}`;
  const [posts, interactions] = await Promise.all([
    prisma.fediPost.findMany({
      where: { OR: [{ domain }, { domain: { endsWith: suffix } }] },
      select: { id: true },
    }),
    prisma.fediInteraction.findMany({
      where: { OR: [{ domain }, { domain: { endsWith: suffix } }] },
      select: { type: true, targetApId: true },
    }),
  ]);

  await prisma.fediPost.deleteMany({ where: { id: { in: posts.map((p) => p.id) } } });
  await prisma.fediInteraction.deleteMany({
    where: { OR: [{ domain }, { domain: { endsWith: suffix } }] },
  });

  // Same counter correction as an actor block — deleting the rows without
  // taking the cached counts down leaves every affected post overstated.
  for (const it of interactions) {
    if (it.type !== "like" && it.type !== "boost") continue;
    const where =
      it.type === "like"
        ? { apId: it.targetApId, likeCount: { gt: 0 } }
        : { apId: it.targetApId, boostCount: { gt: 0 } };
    const data =
      it.type === "like" ? { likeCount: { decrement: 1 } } : { boostCount: { decrement: 1 } };
    await prisma.post.updateMany({ where, data }).catch(() => {});
    await prisma.photo.updateMany({ where, data }).catch(() => {});
  }

  // Drop the relationships too, so we stop delivering to them.
  await prisma.fediFollower.deleteMany({
    where: { OR: [{ domain }, { domain: { endsWith: suffix } }] },
  });
  await prisma.fediFollowing.deleteMany({
    where: { OR: [{ domain }, { domain: { endsWith: suffix } }] },
  });

  return NextResponse.json({ success: true, domain });
}

export async function unblockDomain(body: AdminBody): Promise<NextResponse> {
  const domain = normalizeDomain(typeof body.domain === "string" ? body.domain : "");
  if (!domain) {
    return NextResponse.json({ error: "domain required" }, { status: 400 });
  }
  await prisma.blockedDomain.deleteMany({ where: { domain } });
  return NextResponse.json({ success: true });
}
