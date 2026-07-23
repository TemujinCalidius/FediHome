import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverActivity } from "@/lib/http-signatures";
import { resolveActorInbox } from "@/lib/fedi-resolve";
import { processAttachments, fetchLinkEmbed } from "@/lib/fedi-media";
import { assertPublicHost, isPrivateUrl } from "@/lib/url-guard";
import { sanitizeHtml } from "@/lib/sanitize";
import type { AdminBody } from "./types";
import { getSiteUrl } from "@/lib/identity";

const REMOTE_FETCH_TIMEOUT_MS = 8000;

export async function follow(body: AdminBody): Promise<NextResponse> {
  const { handle } = body;
  // Parse handle: @user@domain or user@domain
  const cleaned = handle.replace(/^@/, "");
  const [username, domain] = cleaned.split("@");

  if (!username || !domain) {
    return NextResponse.json(
      { error: "Invalid handle format. Use @user@domain" },
      { status: 400 }
    );
  }

  // Discover actor via WebFinger
  try {
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
    const actorLink = wfData.links?.find(
      (l: { rel: string; type?: string }) =>
        l.rel === "self" && l.type === "application/activity+json"
    );

    if (!actorLink?.href) throw new Error("No actor link found");
    // H8: a malicious WebFinger response could point us at internal services.
    // Use assertPublicHost (DNS-resolves) so a rebinding hostname is caught.
    if (!(await assertPublicHost(actorLink.href))) {
      throw new Error("blocked: actor URL resolves to private host");
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

    // Store following record
    await prisma.fediFollowing.upsert({
      where: { actorUri: actorLink.href },
      create: {
        actorUri: actorLink.href,
        inbox: actor.inbox,
        username: actor.preferredUsername || username,
        domain,
        displayName: actor.name || null,
        avatarUrl: actor.icon?.url || null,
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

  // Send Block activity
  const follower = await prisma.fediFollower.findUnique({ where: { actorUri } });
  if (follower) {
    try {
      await deliverActivity(follower.inbox, {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${getSiteUrl()}/ap/block/${Date.now()}`,
        type: "Block",
        actor: `${getSiteUrl()}/ap/actor`,
        object: actorUri,
      });
    } catch {
      // Continue
    }
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

  // Delete their interactions
  await prisma.fediInteraction.deleteMany({ where: { actorUri } });

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

  const blocked = await prisma.blockedActor.findUnique({ where: { actorUri } });

  // Deliver Undo(Block) best-effort — prefer the cached inbox, else resolve it.
  const inbox = blocked?.inbox || (await resolveActorInbox(actorUri).catch(() => null));
  if (inbox) {
    await deliverActivity(inbox, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${getSiteUrl()}/ap/undo/${Date.now()}`,
      type: "Undo",
      actor: `${getSiteUrl()}/ap/actor`,
      object: { type: "Block", actor: `${getSiteUrl()}/ap/actor`, object: actorUri },
    }).catch(() => {});
  }

  await prisma.blockedActor.deleteMany({ where: { actorUri } });
  return NextResponse.json({ success: true });
}
