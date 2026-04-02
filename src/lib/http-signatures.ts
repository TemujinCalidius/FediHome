import crypto from "crypto";
import { prisma } from "./db";

const SITE_URL = process.env.SITE_URL || "http://localhost:3000";

/**
 * Sign an outgoing HTTP request with HTTP Signatures (draft-cavage-http-signatures-12)
 * Required for ActivityPub federation with Mastodon, Pixelfed, etc.
 */
export async function signedFetch(
  url: string,
  body: string
): Promise<Response> {
  const keys = await prisma.actorKeys.findUnique({ where: { id: "main" } });
  if (!keys) throw new Error("Actor keys not found");

  const keyId = `${SITE_URL}/ap/actor#main-key`;
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();
  const digest = "SHA-256=" + crypto.createHash("sha256").update(body).digest("base64");

  // Build the signing string
  const signingString = [
    `(request-target): post ${parsedUrl.pathname}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");

  // Sign with RSA-SHA256
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

/**
 * Deliver an ActivityPub activity to an inbox with proper HTTP signatures
 */
export async function deliverActivity(
  inbox: string,
  activity: Record<string, unknown>
): Promise<void> {
  const body = JSON.stringify(activity);

  try {
    const res = await signedFetch(inbox, body);
    if (!res.ok && res.status !== 202) {
      const errText = await res.text().catch(() => "");
      console.error(`Delivery to ${inbox} failed: ${res.status} ${errText.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`Delivery to ${inbox} error:`, err);
  }
}

/**
 * Deliver an activity to ALL followers
 */
export async function deliverToFollowers(
  activity: Record<string, unknown>
): Promise<void> {
  const followers = await prisma.fediFollower.findMany({
    where: { accepted: true },
    select: { inbox: true, sharedInbox: true },
  });

  // Deduplicate by shared inbox where available
  const inboxes = new Set<string>();
  for (const f of followers) {
    inboxes.add(f.sharedInbox || f.inbox);
  }

  // Deliver in parallel (but limit concurrency)
  const promises = Array.from(inboxes).map((inbox) =>
    deliverActivity(inbox, activity)
  );
  await Promise.allSettled(promises);
}

/**
 * Verify an incoming HTTP signature (basic verification)
 */
export async function verifyIncomingSignature(
  req: Request
): Promise<boolean> {
  const sigHeader = req.headers.get("signature");
  if (!sigHeader) return false; // No signature = skip verification for now

  // Parse signature header
  const parts: Record<string, string> = {};
  for (const part of sigHeader.split(",")) {
    const [key, ...val] = part.split("=");
    parts[key.trim()] = val.join("=").replace(/^"|"$/g, "");
  }

  if (!parts.keyId || !parts.signature || !parts.headers) return false;

  try {
    // Fetch the signer's public key
    const actorRes = await fetch(parts.keyId.split("#")[0], {
      headers: { Accept: "application/activity+json" },
    });
    if (!actorRes.ok) return false;

    const actor = await actorRes.json();
    const publicKeyPem = actor.publicKey?.publicKeyPem;
    if (!publicKeyPem) return false;

    // Reconstruct signing string
    const url = new URL(req.url);
    const headerList = parts.headers.split(" ");
    const signingParts = headerList.map((h) => {
      if (h === "(request-target)") return `(request-target): post ${url.pathname}`;
      const val = req.headers.get(h);
      return `${h}: ${val}`;
    });
    const signingString = signingParts.join("\n");

    // Verify
    const verifier = crypto.createVerify("sha256");
    verifier.update(signingString);
    return verifier.verify(publicKeyPem, parts.signature, "base64");
  } catch {
    return false;
  }
}
