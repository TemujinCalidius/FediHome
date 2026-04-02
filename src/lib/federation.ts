import { createFederation, MemoryKvStore } from "@fedify/fedify";
import { prisma } from "./db";
import { siteConfig } from "@/../site.config";
import crypto from "crypto";

const siteUrl = siteConfig.url;
const handle = siteConfig.fediHandle;

// Initialize federation
export const federation = createFederation({
  kv: new MemoryKvStore(),
});

// Ensure actor keys exist
export async function ensureActorKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const existing = await prisma.actorKeys.findUnique({
    where: { id: "main" },
  });

  if (existing) {
    return { publicKey: existing.publicKey, privateKey: existing.privateKey };
  }

  // Generate RSA key pair
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  await prisma.actorKeys.create({
    data: { id: "main", publicKey, privateKey },
  });

  return { publicKey, privateKey };
}

// Get the actor profile JSON
export async function getActorProfile() {
  const keys = await ensureActorKeys();

  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id: `${siteUrl}/ap/actor`,
    type: "Person",
    preferredUsername: handle,
    name: siteConfig.authorName,
    summary: siteConfig.actorSummary,
    url: siteUrl,
    manuallyApprovesFollowers: false,
    discoverable: true,
    inbox: `${siteUrl}/ap/inbox`,
    outbox: `${siteUrl}/ap/outbox`,
    followers: `${siteUrl}/ap/followers`,
    following: `${siteUrl}/ap/following`,
    endpoints: {
      sharedInbox: `${siteUrl}/ap/inbox`,
    },
    icon: {
      type: "Image",
      mediaType: "image/png",
      url: `${siteUrl}${siteConfig.avatarPath}`,
    },
    image: {
      type: "Image",
      mediaType: "image/webp",
      url: `${siteUrl}${siteConfig.bannerPath}`,
    },
    publicKey: {
      id: `${siteUrl}/ap/actor#main-key`,
      owner: `${siteUrl}/ap/actor`,
      publicKeyPem: keys.publicKey,
    },
  };
}
