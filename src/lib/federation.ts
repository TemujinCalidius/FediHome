import { createFederation, MemoryKvStore } from "@fedify/fedify";
import { prisma } from "./db";
import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "./site-profile";
import { getAlsoKnownAs } from "./identity-store";
import { getIdentity, getSiteUrl } from "./identity";
import crypto from "crypto";
import { raiseMaintenanceItem } from "./maintenance";


// Initialize federation
export const federation = createFederation({
  kv: new MemoryKvStore(),
});

/**
 * Does this instance have history? Used to tell "fresh install bootstrapping"
 * apart from "an established instance whose ActorKeys row has gone missing"
 * (#310). Either signal is enough; a DB hiccup answers "no" so we never block
 * a genuine first run.
 */
async function looksEstablished(): Promise<boolean> {
  try {
    const [settings, followers] = await Promise.all([
      prisma.siteSettings.findUnique({ where: { id: "main" }, select: { setupDone: true } }),
      prisma.fediFollower.count(),
    ]);
    return Boolean(settings?.setupDone) || followers > 0;
  } catch {
    return false;
  }
}

/**
 * Record the key regeneration where the owner will actually see it (#310).
 * Reuses the existing MaintenanceItem surface, which NotificationBell already
 * renders in the admin with dismiss support — so no new UI. The unique key is
 * [kind, packageName, latest], so a fixed `latest` collapses repeat calls into
 * one row instead of spamming one per request.
 *
 * **This alert is never auto-resolved**, unlike the rest of #412's sweep, and it
 * is exempt in `NEVER_SWEPT`. Two reasons. It shares `kind: "security"` with
 * `npm audit`, which has no opinion about signing keys. And more fundamentally it
 * records something that *happened* rather than something that *is*: this line is
 * only ever reached in the branch that has just minted a replacement keypair, so
 * "are the keys intact?" is true by construction one instruction later. Resolving
 * on that would clear the alert on the next render and tell the owner nothing.
 * It clears when they dismiss it, which is the correct signal — the damage is
 * historical and only they can judge whether they've recovered from it.
 *
 * Going through `raiseMaintenanceItem` still buys something: a *second* identity
 * loss lands as occurrence 2 on a dismissed-then-resolved row rather than
 * vanishing silently, and repeat keypair loss is exactly the symptom of a volume
 * that isn't persisting.
 */
async function flagKeyRegeneration(): Promise<void> {
  try {
    await raiseMaintenanceItem({
      kind: "security",
      packageName: "federation-identity",
      latest: "actor-keys-regenerated",
      severity: "high",
      title: "Federation identity was regenerated",
      description:
        "Your ActorKeys row was missing, so a new signing keypair was generated. " +
        "Existing followers hold your OLD public key, so posts may fail to verify on " +
        "remote servers until they re-fetch your actor. Common causes: `docker compose down -v`, " +
        "restoring a content-only database dump, or migrating to a new database. " +
        "If you have a backup of the ActorKeys row, restoring it will recover your original identity.",
      url: "https://github.com/TemujinCalidius/FediHome/issues/310",
    });
  } catch (err) {
    // Never let alerting break the render path this sits on.
    console.error("[fedihome] couldn't record the key-regeneration alert:", err);
  }
}

/**
 * The actor's signing keypair, generating it on first use.
 *
 * Bootstrapping a NEW instance silently is correct. Doing the same for an
 * ESTABLISHED instance is not: a missing ActorKeys row there means the keys were
 * LOST (a dropped `pgdata` volume, a content-only restore, a botched migration),
 * and quietly minting a replacement rotates the instance's federation identity
 * with no signal at all. Remote servers still hold the old public key, so
 * outgoing activities can fail signature verification — and nothing says why.
 * We still mint (never brick the site) but make it impossible to miss (#310).
 */
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

  const established = await looksEstablished();

  // Generate RSA key pair
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  await prisma.actorKeys.create({
    data: { id: "main", publicKey, privateKey },
  });

  if (established) {
    console.error(
      "\n[fedihome] ⚠️  FEDERATION IDENTITY REGENERATED\n" +
        "  Your ActorKeys row was missing on an instance that already has history,\n" +
        "  so a NEW signing keypair was just generated. Existing followers still hold\n" +
        "  your OLD public key, so posts may fail to verify until remote servers\n" +
        "  re-fetch your actor.\n" +
        "  Likely cause: `docker compose down -v`, a content-only database restore,\n" +
        "  or a migration that didn't carry the ActorKeys row.\n" +
        "  If you have a backup of that row, restore it to recover your identity.\n" +
        "  See: https://github.com/TemujinCalidius/FediHome/issues/310\n",
    );
    void flagKeyRegeneration(); // fire-and-forget: this runs on a render path
  }

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
  // Account aliases (#326). Only emitted when set, so a default instance's
  // actor document is byte-identical to before.
  const alsoKnownAs = await getAlsoKnownAs();

  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id: `${getSiteUrl()}/ap/actor`,
    type: "Person",
    preferredUsername: getIdentity().fediHandle,
    name: profile.authorName,
    summary: profile.actorSummary,
    url: getSiteUrl(),
    manuallyApprovesFollowers: false,
    discoverable: true,
    // "I am also that account" — the property a remote server checks before it
    // will move someone's followers to us. `alsoKnownAs` is already defined by
    // the activitystreams context above, so no extra JSON-LD term is required.
    ...(alsoKnownAs.length > 0 ? { alsoKnownAs } : {}),
    inbox: `${getSiteUrl()}/ap/inbox`,
    outbox: `${getSiteUrl()}/ap/outbox`,
    followers: `${getSiteUrl()}/ap/followers`,
    following: `${getSiteUrl()}/ap/following`,
    endpoints: {
      sharedInbox: `${getSiteUrl()}/ap/inbox`,
    },
    icon: {
      type: "Image",
      mediaType: imageMediaType(profile.avatarPath),
      url: `${getSiteUrl()}${profile.avatarPath}`,
    },
    image: {
      type: "Image",
      mediaType: imageMediaType(profile.bannerPath),
      url: `${getSiteUrl()}${profile.bannerPath}`,
    },
    publicKey: {
      id: `${getSiteUrl()}/ap/actor#main-key`,
      owner: `${getSiteUrl()}/ap/actor`,
      publicKeyPem: keys.publicKey,
    },
  };
}
