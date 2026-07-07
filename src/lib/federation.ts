import { createFederation, MemoryKvStore } from "@fedify/fedify";
import { prisma } from "./db";
import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "./site-profile";
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

/** Guess an image mediaType from a path extension (default image/jpeg). */
function imageMediaType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif",
  };
  return map[ext] || "image/jpeg";
}

// Get the actor profile JSON
export async function getActorProfile() {
  const keys = await ensureActorKeys();
  // Runtime-editable profile (#201) overlaid on env defaults.
  const profile = await getRuntimeProfile();

  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id: `${siteUrl}/ap/actor`,
    type: "Person",
    preferredUsername: handle,
    name: profile.authorName,
    summary: profile.actorSummary,
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
      mediaType: imageMediaType(profile.avatarPath),
      url: `${siteUrl}${profile.avatarPath}`,
    },
    image: {
      type: "Image",
      mediaType: imageMediaType(profile.bannerPath),
      url: `${siteUrl}${profile.bannerPath}`,
    },
    publicKey: {
      id: `${siteUrl}/ap/actor#main-key`,
      owner: `${siteUrl}/ap/actor`,
      publicKeyPem: keys.publicKey,
    },
  };
}
