import crypto from "crypto";
import { prisma } from "./db";
import { assertPublicHost } from "./url-guard";

const SITE_URL = process.env.SITE_URL || "http://localhost:3000";

const REQUIRED_SIGNED_HEADERS = ["(request-target)", "host", "date", "digest"];
const ACTOR_FETCH_TIMEOUT_MS = 8000;
const REPLAY_WINDOW_MS = 60 * 60 * 1000; // ±1 hour

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
    signal: AbortSignal.timeout(ACTOR_FETCH_TIMEOUT_MS),
  });
}

/**
 * Signed GET for fetching remote AP objects. Many servers run Mastodon's
 * "authorized fetch" (secure mode) and reject UNSIGNED GETs with 401 — which
 * silently breaks reading remote notes, thread ancestors, and interaction
 * collections. Signs `(request-target) host date` with the site actor key.
 */
export async function signedGet(url: string, timeoutMs = 10000): Promise<Response> {
  const keys = await prisma.actorKeys.findUnique({ where: { id: "main" } });
  if (!keys) throw new Error("Actor keys not found");

  const keyId = `${SITE_URL}/ap/actor#main-key`;
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();
  const target = `${parsedUrl.pathname}${parsedUrl.search}`;

  const signingString = [
    `(request-target): get ${target}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
  ].join("\n");

  const signer = crypto.createSign("sha256");
  signer.update(signingString);
  const signature = signer.sign(keys.privateKey, "base64");

  const signatureHeader = [
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="(request-target) host date"`,
    `signature="${signature}"`,
  ].join(",");

  return fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/activity+json, application/ld+json",
      Date: date,
      Signature: signatureHeader,
      Host: parsedUrl.host,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export interface DeliveryResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Deliver an ActivityPub activity to an inbox with proper HTTP signatures.
 * Returns the result so callers (e.g. DM send) can surface delivery status
 * to the user instead of silently failing.
 */
export async function deliverActivity(
  inbox: string,
  activity: Record<string, unknown>
): Promise<DeliveryResult> {
  const body = JSON.stringify(activity);

  try {
    const res = await signedFetch(inbox, body);
    if (res.ok || res.status === 202) {
      return { ok: true, status: res.status };
    }
    const errText = await res.text().catch(() => "");
    const trimmed = errText.slice(0, 200);
    console.error(`Delivery to ${inbox} failed: ${res.status} ${trimmed}`);
    return { ok: false, status: res.status, error: `${res.status}: ${trimmed}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Delivery to ${inbox} error:`, err);
    return { ok: false, status: 0, error: msg };
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

export type SignatureVerification =
  | { valid: true; actorUri: string }
  | { valid: false; reason: string };

/**
 * Verify an incoming HTTP signature.
 *
 * Caller must supply the raw request body so that:
 *   1. We can recompute Digest and compare to the signed Digest header.
 *   2. The body cannot be tampered with after signature verification.
 *
 * Returns the actor URI extracted from `keyId`. Callers must compare this
 * to the activity's `actor` field to prevent cross-actor spoofing (C5).
 */
export async function verifyIncomingSignature(
  req: Request,
  rawBody: string
): Promise<SignatureVerification> {
  const sigHeader = req.headers.get("signature");
  if (!sigHeader) return { valid: false, reason: "missing signature header" };

  // Parse signature header — split on commas, then split each on first '='
  const parts: Record<string, string> = {};
  for (const part of sigHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
    parts[key] = val;
  }

  if (!parts.keyId || !parts.signature || !parts.headers) {
    return { valid: false, reason: "malformed signature header" };
  }

  // H6: enforce minimum signed headers so the signature commits to body+host+time
  const signedHeaders = parts.headers.split(/\s+/).filter(Boolean);
  for (const required of REQUIRED_SIGNED_HEADERS) {
    if (!signedHeaders.includes(required)) {
      return { valid: false, reason: `signature must cover ${required}` };
    }
  }

  // H6: replay window — Date header must be within ±1 hour
  const dateHeader = req.headers.get("date");
  const dateMs = dateHeader ? Date.parse(dateHeader) : NaN;
  if (!Number.isFinite(dateMs) || Math.abs(Date.now() - dateMs) > REPLAY_WINDOW_MS) {
    return { valid: false, reason: "date header missing or outside replay window" };
  }

  // C4: Digest header must match SHA-256 of the actual request body
  const expectedDigest =
    "SHA-256=" + crypto.createHash("sha256").update(rawBody).digest("base64");
  const sentDigest = req.headers.get("digest") || "";
  const expectedBuf = Buffer.from(expectedDigest);
  const sentBuf = Buffer.from(sentDigest);
  if (
    expectedBuf.length !== sentBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, sentBuf)
  ) {
    return { valid: false, reason: "digest mismatch" };
  }

  // Fetch the signer's public key (with timeout to prevent slowloris-style DoS — H7)
  const actorUriFromKey = parts.keyId.split("#")[0];
  // SSRF guard: keyId originates from an attacker-controlled signature header.
  if (!(await assertPublicHost(actorUriFromKey))) {
    return { valid: false, reason: "keyId resolves to private/blocked host" };
  }
  let actor: { publicKey?: { publicKeyPem?: string }; id?: string };
  try {
    const actorRes = await fetch(actorUriFromKey, {
      headers: { Accept: "application/activity+json" },
      signal: AbortSignal.timeout(ACTOR_FETCH_TIMEOUT_MS),
    });
    if (!actorRes.ok) return { valid: false, reason: `actor fetch failed: ${actorRes.status}` };
    actor = await actorRes.json();
  } catch (err) {
    return { valid: false, reason: `actor fetch error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const publicKeyPem = actor.publicKey?.publicKeyPem;
  if (!publicKeyPem) return { valid: false, reason: "no public key in actor" };

  // Reconstruct signing string in the order specified by `headers=`
  const url = new URL(req.url);
  const method = req.method.toLowerCase();
  const signingParts: string[] = [];
  for (const h of signedHeaders) {
    if (h === "(request-target)") {
      signingParts.push(`(request-target): ${method} ${url.pathname}${url.search}`);
    } else {
      const val = req.headers.get(h);
      if (val === null) {
        return { valid: false, reason: `signed header ${h} not present on request` };
      }
      signingParts.push(`${h}: ${val}`);
    }
  }
  const signingString = signingParts.join("\n");

  try {
    const verifier = crypto.createVerify("sha256");
    verifier.update(signingString);
    const ok = verifier.verify(publicKeyPem, parts.signature, "base64");
    if (!ok) return { valid: false, reason: "signature verification failed" };
  } catch (err) {
    return { valid: false, reason: `verifier error: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { valid: true, actorUri: actorUriFromKey };
}

/**
 * Returns true if a verified signer (actorUri from keyId) is allowed to act
 * on behalf of the actor claimed in the activity body.
 *
 * Strict: hostname must match. Mastodon, Pixelfed, etc. all use the same
 * hostname for keyId and actor.id. This blocks the cross-domain spoofing
 * scenario described in C5 of the audit.
 */
export function actorMatchesSigner(signerUri: string, claimedActorUri: string): boolean {
  try {
    const a = new URL(signerUri);
    const b = new URL(claimedActorUri);
    return a.host.toLowerCase() === b.host.toLowerCase();
  } catch {
    return false;
  }
}
