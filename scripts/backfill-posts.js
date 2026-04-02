/**
 * Backfill posts from all followed accounts.
 * Follows outbox pagination to pull posts from the last N hours.
 *
 * Usage: DATABASE_URL="..." node scripts/backfill-posts.js [hours]
 * Default: 48 hours
 */
const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");

const prisma = new PrismaClient();
const SITE_URL = process.env.SITE_URL || "http://localhost:3000";
const MAX_POSTS_PER_ACCOUNT = 50;

let _keys = null;
async function getKeys() {
  if (!_keys) _keys = await prisma.actorKeys.findUnique({ where: { id: "main" } });
  return _keys;
}

async function signedGet(url) {
  const keys = await getKeys();
  const keyId = `${SITE_URL}/ap/actor#main-key`;
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();

  const sigParts = [
    `(request-target): get ${parsedUrl.pathname}${parsedUrl.search ? parsedUrl.search : ""}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
  ];

  const signer = crypto.createSign("sha256");
  signer.update(sigParts.join("\n"));
  const signature = signer.sign(keys.privateKey, "base64");

  const signatureHeader = [
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="(request-target) host date"`,
    `signature="${signature}"`,
  ].join(",");

  const res = await fetch(url, {
    headers: {
      Accept: "application/activity+json",
      Date: date,
      Host: parsedUrl.host,
      Signature: signatureHeader,
    },
    signal: AbortSignal.timeout(10000),
  });

  return res;
}

async function fetchOutboxPage(url) {
  // Try unsigned first, fall back to signed
  let res = await fetch(url, {
    headers: { Accept: "application/activity+json" },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 401 || res.status === 403) {
    res = await signedGet(url);
  }

  if (!res.ok) return null;
  return res.json();
}

async function backfillAccount(f, cutoffDate) {
  try {
    // Fetch actor to get outbox URL
    let actorRes = await fetch(f.actorUri, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(10000),
    });

    if (actorRes.status === 401 || actorRes.status === 403) {
      actorRes = await signedGet(f.actorUri);
    }

    if (!actorRes.ok) return { stored: 0, error: `actor ${actorRes.status}` };

    const actor = await actorRes.json();
    if (!actor.outbox) return { stored: 0, error: "no outbox" };

    // Fetch outbox collection
    const outbox = await fetchOutboxPage(actor.outbox);
    if (!outbox) return { stored: 0, error: "outbox fetch failed" };

    // Get items - either inline or from first page
    let items = outbox.orderedItems || outbox.items || [];
    let nextPage = null;

    // If outbox is a collection with a first page, follow it
    if (items.length === 0 && outbox.first) {
      const firstUrl = typeof outbox.first === "string" ? outbox.first : outbox.first.id;
      if (firstUrl) {
        const page = await fetchOutboxPage(firstUrl);
        if (page) {
          items = page.orderedItems || page.items || [];
          nextPage = page.next || null;
        }
      }
    }

    let stored = 0;
    let reachedCutoff = false;

    // Process items, following pagination
    while (items.length > 0 && stored < MAX_POSTS_PER_ACCOUNT && !reachedCutoff) {
      for (const item of items) {
        if (stored >= MAX_POSTS_PER_ACCOUNT) break;

        const note = item.type === "Create" ? item.object : item;
        if (!note?.id || !note?.content) continue;

        const published = note.published ? new Date(note.published) : null;
        if (published && published < cutoffDate) {
          reachedCutoff = true;
          break;
        }

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

        try {
          await prisma.fediPost.upsert({
            where: { apId: note.id },
            create: {
              actorUri: f.actorUri,
              apId: note.id,
              content: note.content,
              contentHtml: note.content,
              mediaUrls,
              mediaTypes,
              inReplyTo,
              conversationId,
              username: f.username,
              domain: f.domain,
              displayName: f.displayName || actor.name || null,
              avatarUrl: f.avatarUrl || actor.icon?.url || null,
              publishedAt: published || new Date(),
            },
            update: {},
          });
          stored++;
        } catch {
          // duplicate or other DB error, skip
        }
      }

      // Follow pagination if we haven't hit cutoff
      if (!reachedCutoff && stored < MAX_POSTS_PER_ACCOUNT && nextPage) {
        const page = await fetchOutboxPage(nextPage);
        if (page) {
          items = page.orderedItems || page.items || [];
          nextPage = page.next || null;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    return { stored, error: null };
  } catch (err) {
    return { stored: 0, error: err.message?.slice(0, 60) };
  }
}

async function run() {
  const hours = parseInt(process.argv[2] || "48", 10);
  const cutoffDate = new Date(Date.now() - hours * 60 * 60 * 1000);
  console.log(`Backfilling posts from the last ${hours} hours (since ${cutoffDate.toISOString()})\n`);

  const following = await prisma.fediFollowing.findMany({
    orderBy: { username: "asc" },
  });

  console.log(`Processing ${following.length} followed accounts...\n`);

  let totalStored = 0;

  for (const f of following) {
    process.stdout.write(`  ${f.username}@${f.domain} ... `);
    const { stored, error } = await backfillAccount(f, cutoffDate);

    if (error) {
      console.log(`${stored} posts (${error})`);
    } else {
      console.log(`${stored} posts`);
    }

    totalStored += stored;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone: ${totalStored} total posts backfilled`);
  await prisma.$disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
