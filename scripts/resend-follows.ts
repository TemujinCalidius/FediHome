// @ts-nocheck — one-off maintenance script (run via tsx, not type-checked)
/**
 * Re-send Follow requests with HTTP signatures to all accounts in FediFollowing.
 * Run this after implementing HTTP signatures to fix unsigned follows.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as crypto from "node:crypto";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const SITE_URL = process.env.SITE_URL || "http://localhost:3000";

async function signedFetch(url, body) {
  const keys = await prisma.actorKeys.findUnique({ where: { id: "main" } });
  if (!keys) throw new Error("Actor keys not found — run the site first to generate them");

  const keyId = `${SITE_URL}/ap/actor#main-key`;
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();
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

async function run() {
  const following = await prisma.fediFollowing.findMany();
  console.log(`Re-sending Follow requests for ${following.length} accounts...`);

  let success = 0, failed = 0;

  for (const f of following) {
    const activity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${SITE_URL}/ap/follow/${Date.now()}-${f.id.slice(-4)}`,
      type: "Follow",
      actor: `${SITE_URL}/ap/actor`,
      object: f.actorUri,
    };

    try {
      const res = await signedFetch(f.inbox, JSON.stringify(activity));
      if (res.ok || res.status === 202) {
        console.log(`  ✓ ${f.username}@${f.domain}`);
        success++;
      } else {
        const err = await res.text().catch(() => "");
        console.log(`  ✗ ${f.username}@${f.domain}: ${res.status} ${err.slice(0, 100)}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ✗ ${f.username}@${f.domain}: ${err.message?.slice(0, 100)}`);
      failed++;
    }

    // Rate limit — don't spam
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone: ${success} success, ${failed} failed`);
  await prisma.$disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
