// @ts-nocheck — one-off maintenance script (run via tsx, not type-checked)
/**
 * Fix broken FediFollowing records:
 * 1. Remove duplicates (keep the one with avatar, or the newer one)
 * 2. Re-fetch actor info via WebFinger for records missing avatars
 * 3. Update actorUri to the canonical AP ID
 * 4. Re-send signed Follow activities
 * 5. Backfill recent posts from their outbox
 *
 * Usage: DATABASE_URL="..." node scripts/fix-follows.js
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as crypto from "node:crypto";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const SITE_URL = process.env.SITE_URL || "http://localhost:3000";

async function signedFetch(url, method, body) {
  const keys = await prisma.actorKeys.findUnique({ where: { id: "main" } });
  if (!keys) throw new Error("Actor keys not found");

  const keyId = `${SITE_URL}/ap/actor#main-key`;
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();

  if (method === "POST" && body) {
    const digest = "SHA-256=" + crypto.createHash("sha256").update(body).digest("base64");

    const signingString = [
      `(request-target): post ${parsedUrl.pathname}`,
      `host: ${parsedUrl.host}`,
      `date: ${date}`,
      `digest: ${digest}`,
    ].join("\n");

    const signer = crypto.createSign("sha256");
    signer.update(signingString);
    const signature = signer.sign(keys.privateKey, "base64");

    const signatureHeader = [
      `keyId="${keyId}"`,
      `algorithm="rsa-sha256"`,
      `headers="(request-target) host date digest"`,
      `signature="${signature}"`,
    ].join(",");

    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/activity+json",
        Date: date,
        Digest: digest,
        Signature: signatureHeader,
        Host: parsedUrl.host,
      },
      body,
    });
  }

  // GET request (unsigned, for public resources)
  return fetch(url, {
    headers: { Accept: "application/activity+json" },
  });
}

async function discoverActor(username, domain) {
  // WebFinger lookup
  const wfRes = await fetch(
    `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`,
    { headers: { Accept: "application/jrd+json" } }
  );
  if (!wfRes.ok) throw new Error(`WebFinger failed: ${wfRes.status}`);

  const wfData = await wfRes.json();
  const actorLink = wfData.links?.find(
    (l) => l.rel === "self" && l.type === "application/activity+json"
  );
  if (!actorLink?.href) throw new Error("No actor self link");

  // Fetch actor profile
  const actorRes = await fetch(actorLink.href, {
    headers: { Accept: "application/activity+json" },
  });
  if (!actorRes.ok) throw new Error(`Actor fetch failed: ${actorRes.status}`);

  const actor = await actorRes.json();
  return {
    actorUri: actorLink.href,
    inbox: actor.inbox,
    username: actor.preferredUsername || username,
    domain,
    displayName: actor.name || null,
    avatarUrl: actor.icon?.url || null,
    outbox: actor.outbox || null,
  };
}

async function backfillPosts(actorUri, outboxUrl, username, domain, displayName, avatarUrl) {
  if (!outboxUrl) return 0;

  try {
    const outboxRes = await fetch(outboxUrl, {
      headers: { Accept: "application/activity+json" },
    });
    if (!outboxRes.ok) return 0;

    const outbox = await outboxRes.json();
    const items = outbox.orderedItems || outbox.items || [];
    let count = 0;

    for (const item of items.slice(0, 10)) {
      const note = item.type === "Create" ? item.object : item;
      if (!note?.id || !note?.content) continue;

      const mediaUrls = [];
      const mediaTypes = [];
      if (Array.isArray(note.attachment)) {
        for (const att of note.attachment) {
          if (att.url) {
            const mType = (att.mediaType || "").startsWith("video/") ? "video" : "image";
            mediaUrls.push(att.url);
            mediaTypes.push(mType);
          }
        }
      }

      const inReplyTo = note.inReplyTo || null;
      const conversationId = note.conversation || note.context || inReplyTo || note.id;

      await prisma.fediPost.upsert({
        where: { apId: note.id },
        create: {
          actorUri,
          apId: note.id,
          content: note.content,
          contentHtml: note.content,
          mediaUrls,
          mediaTypes,
          inReplyTo,
          conversationId,
          username,
          domain,
          displayName,
          avatarUrl,
          publishedAt: note.published ? new Date(note.published) : new Date(),
        },
        update: {},
      });
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

async function run() {
  const allFollowing = await prisma.fediFollowing.findMany({
    orderBy: { createdAt: "asc" },
  });

  console.log(`Total FediFollowing records: ${allFollowing.length}\n`);

  // Step 1: Remove duplicates (same username@domain)
  console.log("=== Step 1: Removing duplicates ===");
  const seen = new Map();
  const toDelete = [];

  for (const f of allFollowing) {
    const key = `${f.username.toLowerCase()}@${f.domain.toLowerCase()}`;
    if (seen.has(key)) {
      const existing = seen.get(key);
      // Keep the one with avatar, or the newer one
      if (!existing.avatarUrl && f.avatarUrl) {
        toDelete.push(existing.id);
        seen.set(key, f);
      } else {
        toDelete.push(f.id);
      }
    } else {
      seen.set(key, f);
    }
  }

  if (toDelete.length > 0) {
    console.log(`  Removing ${toDelete.length} duplicates...`);
    for (const id of toDelete) {
      const rec = allFollowing.find((f) => f.id === id);
      console.log(`    - ${rec.username}@${rec.domain}`);
      await prisma.fediFollowing.delete({ where: { id } });
    }
  } else {
    console.log("  No duplicates found.");
  }

  // Step 2: Fix records missing avatars
  console.log("\n=== Step 2: Re-fetching broken follows ===");
  const remaining = [...seen.values()];
  const broken = remaining.filter((f) => !f.avatarUrl);
  console.log(`  ${broken.length} follows missing avatar data\n`);

  let fixed = 0, failed = 0;

  for (const f of broken) {
    process.stdout.write(`  ${f.username}@${f.domain} ... `);

    try {
      const actor = await discoverActor(f.username, f.domain);

      // Update the record with proper data
      await prisma.fediFollowing.update({
        where: { id: f.id },
        data: {
          actorUri: actor.actorUri,
          inbox: actor.inbox,
          username: actor.username,
          displayName: actor.displayName,
          avatarUrl: actor.avatarUrl,
        },
      });

      // Send Follow activity
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${SITE_URL}/ap/follow/${Date.now()}-${f.id.slice(-4)}`,
        type: "Follow",
        actor: `${SITE_URL}/ap/actor`,
        object: actor.actorUri,
      };

      const res = await signedFetch(actor.inbox, "POST", JSON.stringify(activity));
      const followStatus = res.ok || res.status === 202 ? "follow sent" : `follow ${res.status}`;

      // Backfill posts
      const postCount = await backfillPosts(
        actor.actorUri, actor.outbox,
        actor.username, f.domain, actor.displayName, actor.avatarUrl
      );

      console.log(`OK (${followStatus}, ${postCount} posts backfilled)`);
      fixed++;
    } catch (err) {
      console.log(`FAILED: ${err.message?.slice(0, 80)}`);
      failed++;
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 800));
  }

  console.log(`\n=== Done ===`);
  console.log(`Duplicates removed: ${toDelete.length}`);
  console.log(`Follows fixed: ${fixed}`);
  console.log(`Follows failed: ${failed}`);
  await prisma.$disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
