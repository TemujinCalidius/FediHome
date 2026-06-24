import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deliverToFollowers } from "@/lib/http-signatures";
import { siteConfig } from "@/../site.config";
import {
  syncBlueskyGraph,
  followBlueskyAccount,
  unfollowBlueskyAccount,
  resolveBlueskyActor,
} from "@/lib/bluesky-graph";
import { syncBlueskyNotifications } from "@/lib/bluesky-notifications";
import type { AdminBody } from "./types";

const siteUrl = siteConfig.url;

export async function bskyReply(body: AdminBody): Promise<NextResponse> {
  const { content: bskyReplyContent, blueskyUri: parentUri, crosspostFedi } = body;
  if (!bskyReplyContent || !parentUri) {
    return NextResponse.json({ error: "content and blueskyUri required" }, { status: 400 });
  }
  const bskyHandle = process.env.BLUESKY_HANDLE;
  const bskyPassword = process.env.BLUESKY_APP_PASSWORD;
  if (!bskyHandle || !bskyPassword) {
    return NextResponse.json({ error: "Bluesky not configured" }, { status: 500 });
  }
  try {
    const { BskyAgent } = await import("@atproto/api");
    const agent = new BskyAgent({ service: "https://bsky.social" });
    await agent.login({ identifier: bskyHandle, password: bskyPassword });
    const uriParts = parentUri.replace("at://", "").split("/");
    const repo = uriParts[0];
    const rkey = uriParts[uriParts.length - 1];
    const parentPost = await agent.getPost({ repo, rkey }) as { uri: string; cid: string; value: Record<string, unknown> };
    const parentCid = parentPost.cid;
    const parentReplyRef = parentPost.value.reply as { root: { uri: string; cid: string } } | undefined;
    const rootRef = parentReplyRef
      ? { uri: parentReplyRef.root.uri, cid: parentReplyRef.root.cid }
      : { uri: parentUri, cid: parentCid };
    await agent.post({
      text: bskyReplyContent,
      reply: { root: rootRef, parent: { uri: parentUri, cid: parentCid } },
    });

    // Optional Fediverse crosspost — federates as a fedi Note
    if (crosspostFedi) {
      try {
        const localPostFromBsky = await prisma.post.findFirst({
          where: { blueskyUri: parentUri },
          select: { apId: true },
        });
        const linkedContent = bskyReplyContent.replace(
          /(https?:\/\/[^\s<]+)/g,
          (url: string) => `<a href="${url}" rel="nofollow noopener noreferrer" target="_blank">${url}</a>`
        );
        const fediHtml = `<p>${linkedContent}</p>`;
        const fediReplyId = `${siteUrl}/ap/reply/${Date.now()}`;
        const fediActivity = {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${siteUrl}/ap/create/bsky-reply-${Date.now()}`,
          type: "Create",
          actor: `${siteUrl}/ap/actor`,
          published: new Date().toISOString(),
          object: {
            type: "Note",
            id: fediReplyId,
            attributedTo: `${siteUrl}/ap/actor`,
            content: fediHtml,
            published: new Date().toISOString(),
            to: ["https://www.w3.org/ns/activitystreams#Public"],
            cc: [`${siteUrl}/ap/followers`],
            ...(localPostFromBsky?.apId ? { inReplyTo: localPostFromBsky.apId } : {}),
          },
        };
        deliverToFollowers(fediActivity).catch((err) =>
          console.error("Fedi crosspost from bsky_reply failed:", err)
        );
        const fediHandle = siteConfig.fediHandle;
        const siteDomain = new URL(siteUrl).hostname;
        await prisma.fediPost.upsert({
          where: { apId: fediReplyId },
          create: {
            actorUri: `${siteUrl}/ap/actor`,
            apId: fediReplyId,
            content: bskyReplyContent,
            contentHtml: fediHtml,
            mediaUrls: [],
            mediaTypes: [],
            username: fediHandle,
            domain: siteDomain,
            displayName: siteConfig.authorName,
            avatarUrl: siteConfig.avatarPath,
            inReplyTo: localPostFromBsky?.apId ?? null,
            isOutgoing: true,
            publishedAt: new Date(),
          },
          update: {},
        });
      } catch (err) {
        console.error("Fedi crosspost from bsky_reply prep failed:", err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Bluesky reply failed:", err);
    return NextResponse.json({ error: "Bluesky reply failed" }, { status: 500 });
  }
}

export async function syncGraph(): Promise<NextResponse> {
  try {
    const counts = await syncBlueskyGraph();
    // The "Sync Bluesky" button also pulls in interaction notifications (likes,
    // reposts, replies, mentions, quotes, follows) into the bell (#134) — keep
    // it best-effort so a notifications hiccup doesn't fail the graph sync.
    const notifications = await syncBlueskyNotifications().catch((err) => {
      console.error("Bluesky notifications sync failed:", err);
      return null;
    });
    return NextResponse.json({ success: true, ...counts, notifications });
  } catch (err) {
    console.error("Bluesky graph sync failed:", err);
    return NextResponse.json({ error: "Bluesky graph sync failed" }, { status: 500 });
  }
}

export async function bskyFollow(body: AdminBody): Promise<NextResponse> {
  const { did, handleOrDid } = body;
  try {
    const targetDid = did || (handleOrDid ? await resolveBlueskyActor(handleOrDid) : null);
    if (!targetDid) {
      return NextResponse.json({ error: "did or handleOrDid required" }, { status: 400 });
    }
    await followBlueskyAccount(targetDid);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Bluesky follow failed:", err);
    return NextResponse.json({ error: `Bluesky follow failed: ${err}` }, { status: 500 });
  }
}

export async function bskyUnfollow(body: AdminBody): Promise<NextResponse> {
  const { followingId } = body;
  if (!followingId) {
    return NextResponse.json({ error: "followingId required" }, { status: 400 });
  }
  try {
    await unfollowBlueskyAccount(followingId);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("Missing followUri") ? 422 : 500;
    console.error("Bluesky unfollow failed:", err);
    return NextResponse.json({ error: message }, { status });
  }
}
