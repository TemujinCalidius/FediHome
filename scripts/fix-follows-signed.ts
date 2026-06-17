// @ts-nocheck — one-off maintenance script (run via tsx, not type-checked)
/**
 * Fix remaining follows that need signed GET requests.
 * Some servers (social.lol, defcon.social, tech.lgbt, etc.) require
 * HTTP signatures even on GET requests to fetch actor profiles.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as crypto from "node:crypto";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const SITE_URL = process.env.SITE_URL || "http://localhost:3000";

let _keys = null;
async function getKeys() {
  if (!_keys) _keys = await prisma.actorKeys.findUnique({ where: { id: "main" } });
  return _keys;
}

async function signedRequest(url, method, body) {
  const keys = await getKeys();
  const keyId = `${SITE_URL}/ap/actor#main-key`;
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();

  const headers = {
    Accept: "application/activity+json",
    Date: date,
    Host: parsedUrl.host,
  };

  let sigHeaders = "(request-target) host date";
  let sigParts = [
    `(request-target): ${method.toLowerCase()} ${parsedUrl.pathname}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
  ];

  if (method === "POST" && body) {
    const digest = "SHA-256=" + crypto.createHash("sha256").update(body).digest("base64");
    headers["Content-Type"] = "application/activity+json";
    headers["Digest"] = digest;
    sigHeaders += " digest";
    sigParts.push(`digest: ${digest}`);
  }

  const signingString = sigParts.join("\n");
  const signer = crypto.createSign("sha256");
  signer.update(signingString);
  const signature = signer.sign(keys.privateKey, "base64");

  headers["Signature"] = [
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="${sigHeaders}"`,
    `signature="${signature}"`,
  ].join(",");

  return fetch(url, { method, headers, body: method === "POST" ? body : undefined });
}

async function discoverActorSigned(username, domain) {
  // WebFinger (usually doesn't need signing)
  const wfRes = await fetch(
    `https://${domain}/.well-known/webfinger?resource=acct:${username}@${domain}`,
    { headers: { Accept: "application/jrd+json" } }
  );
  if (!wfRes.ok) throw new Error(`WebFinger ${wfRes.status}`);

  const wfData = await wfRes.json();
  const actorLink = wfData.links?.find(
    (l) => l.rel === "self" && l.type === "application/activity+json"
  );
  if (!actorLink?.href) throw new Error("No actor self link");

  // Signed GET for actor profile
  const actorRes = await signedRequest(actorLink.href, "GET");
  if (!actorRes.ok) throw new Error(`Actor fetch ${actorRes.status}`);

  const actor = await actorRes.json();
  return {
    actorUri: actorLink.href,
    inbox: actor.inbox,
    username: actor.preferredUsername || username,
    displayName: actor.name || null,
    avatarUrl: actor.icon?.url || null,
    outbox: actor.outbox || null,
  };
}

async function run() {
  // Get follows still missing proper data
  const broken = await prisma.fediFollowing.findMany({
    where: { avatarUrl: null },
  });

  console.log(`${broken.length} follows still need fixing\n`);

  let fixed = 0, failed = 0;

  for (const f of broken) {
    process.stdout.write(`  ${f.username}@${f.domain} ... `);

    try {
      const actor = await discoverActorSigned(f.username, f.domain);

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

      // Send signed Follow
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${SITE_URL}/ap/follow/${Date.now()}-${f.id.slice(-4)}`,
        type: "Follow",
        actor: `${SITE_URL}/ap/actor`,
        object: actor.actorUri,
      };

      const res = await signedRequest(actor.inbox, "POST", JSON.stringify(activity));
      const status = res.ok || res.status === 202 ? "follow sent" : `follow ${res.status}`;
      console.log(`OK (${status})`);
      fixed++;
    } catch (err) {
      console.log(`FAILED: ${err.message?.slice(0, 80)}`);
      failed++;
    }

    await new Promise((r) => setTimeout(r, 800));
  }

  console.log(`\nFixed: ${fixed}, Failed: ${failed}`);
  await prisma.$disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
