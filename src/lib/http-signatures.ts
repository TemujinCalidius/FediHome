import crypto from "crypto";
import { prisma } from "./db";
import { blockedRecipient, partitionBlockedRecipients } from "./blocks";
import { assertPublicHost } from "./url-guard";
import { getIdentity } from "./identity";


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
  // SSRF defense-in-depth: callers generally vet the target inbox, but guard
  // here too so a signed POST can never be coerced to a private/internal host.
  if (!(await assertPublicHost(url))) {
    throw new Error(`signedFetch: refusing non-public host ${url}`);
  }
  const keys = await prisma.actorKeys.findUnique({ where: { id: "main" } });
  if (!keys) throw new Error("Actor keys not found");

  const keyId = getIdentity().keyId;
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
  // SSRF defense-in-depth: callers vet the target, but guard here too so a
  // signed GET can never be coerced to a private/internal host.
  if (!(await assertPublicHost(url))) {
    throw new Error(`signedGet: refusing non-public host ${url}`);
  }
  const keys = await prisma.actorKeys.findUnique({ where: { id: "main" } });
  if (!keys) throw new Error("Actor keys not found");

  const keyId = getIdentity().keyId;
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
  /** Retrying cannot help. Callers MUST discard rather than enqueue (#379). */
  permanent?: boolean;
  /** Set when OUR policy stopped it, not the remote. `status` is 0. */
  blockedBy?: "actor" | "domain";
}

/**
 * Statuses where the remote has given a definitive answer. Re-sending the same
 * activity to the same inbox will get the same answer, so a 6-attempt / ~31h
 * ladder just burns requests at a server that has already told us no.
 *
 * 5xx, 429, 408 and 0 (network) are deliberately absent — those are exactly the
 * transient failures the retry queue exists for.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

export interface DeliveryTarget {
  /**
   * The recipient's actor URI, when the caller knows it. REQUIRED for
   * actor-level block enforcement: an inbox may be shared by every account on
   * an instance, so it cannot identify one of them. See `blocks.ts`.
   */
  actorUri?: string | null;
  /**
   * Deliver even to a blocked recipient. Exactly ONE production caller —
   * `block()`'s farewell `Undo(Follow)`. Grep for it; one hit is expected.
   */
  bypassBlocks?: boolean;
}

/**
 * Deliver an ActivityPub activity to an inbox with proper HTTP signatures.
 * Returns the result so callers (e.g. DM send) can surface delivery status
 * to the user instead of silently failing.
 *
 * Refuses blocked recipients **before** signing or connecting, so a block means
 * zero network contact rather than a request the remote can observe (#379).
 */
export async function deliverActivity(
  inbox: string,
  activity: Record<string, unknown>,
  target: DeliveryTarget = {}
): Promise<DeliveryResult> {
  if (!target.bypassBlocks) {
    const verdict = await blockedRecipient({ inbox, actorUri: target.actorUri });
    if (verdict.blocked) {
      return {
        ok: false,
        status: 0,
        error: `blocked: ${verdict.reason}`,
        permanent: verdict.permanent,
        ...(verdict.reason === "unavailable" ? {} : { blockedBy: verdict.reason }),
      };
    }
  }

  const body = JSON.stringify(activity);

  try {
    const res = await signedFetch(inbox, body);
    if (res.ok || res.status === 202) {
      return { ok: true, status: res.status };
    }
    const errText = await res.text().catch(() => "");
    const trimmed = errText.slice(0, 200);
    console.error(`Delivery to ${inbox} failed: ${res.status} ${trimmed}`);
    return {
      ok: false,
      status: res.status,
      error: `${res.status}: ${trimmed}`,
      permanent: PERMANENT_STATUSES.has(res.status),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Delivery to %s error:", inbox, err);
    return { ok: false, status: 0, error: msg };
  }
}

// First retry fires 2 minutes after a delivery fails (#207); subsequent
// backoff is scheduled by the retry job (src/lib/delivery-retry.ts).
const FIRST_RETRY_DELAY_MS = 2 * 60_000;

/**
 * Record failed follower deliveries so the scheduler can retry them (#207).
 * Best-effort and idempotent per (activityId, inbox) — a redelivery of the same
 * activity to the same inbox bumps the existing row rather than duplicating it.
 * Never throws: enqueueing must not break the (already best-effort) delivery.
 */
export async function enqueueFailedDeliveries(
  activityId: string,
  activityJson: string,
  failures: { inbox: string; error: string; permanent?: boolean }[]
): Promise<void> {
  // Filtered HERE rather than at each call site, so a future caller can't forget
  // and quietly queue 31 hours of retries against a recipient we refuse to talk
  // to, or a server that has already answered definitively (#379).
  const retryable = failures.filter((f) => !f.permanent);
  if (retryable.length === 0) return;
  const nextRetryAt = new Date(Date.now() + FIRST_RETRY_DELAY_MS);
  await Promise.all(
    retryable.map((f) =>
      prisma.failedDelivery
        .upsert({
          where: { activityId_inbox: { activityId, inbox: f.inbox } },
          create: { activityId, inbox: f.inbox, activity: activityJson, attempts: 1, nextRetryAt, lastError: f.error.slice(0, 300) },
          update: { attempts: { increment: 1 }, lastError: f.error.slice(0, 300) },
        })
        .catch((err) => console.error(`Failed to enqueue delivery retry for ${f.inbox}:`, err))
    )
  );
}

/**
 * Deliver an activity to ALL followers. Fire-and-forget for the caller, but a
 * per-inbox failure is now persisted to FailedDelivery so the scheduler retries
 * it with backoff (#207) — a transiently-down follower no longer silently loses
 * the post. Retries re-send the identical activity JSON (stable id → remote
 * dedupe).
 */
export async function deliverToFollowers(
  activity: Record<string, unknown>
): Promise<void> {
  const followers = await prisma.fediFollower.findMany({
    where: { accepted: true },
    select: { inbox: true, sharedInbox: true, actorUri: true },
  });

  // Drop blocked followers before fan-out (#379). Their rows normally disappear
  // when you block them, but not always: `blockDomain()` matched on the stored
  // `domain` column, which used to keep a port, so a follower on a non-default
  // port survived the purge and kept receiving every post.
  const { allowed, unavailable } = await partitionBlockedRecipients(followers);
  if (unavailable) {
    // Fail closed, but transiently — nothing is delivered and nothing is queued,
    // so the next post goes out normally once the database recovers. Silently
    // broadcasting to a blocked instance would not be recoverable.
    console.error("Delivery to followers skipped: block list unreadable");
    return;
  }

  // Deduplicate by shared inbox where available. An actor URI is only carried
  // through for a private inbox — a shared one serves many accounts, so pinning
  // it to whichever follower we saw first would be wrong.
  const byInbox = new Map<string, string | null>();
  for (const f of allowed) {
    const inbox = f.sharedInbox || f.inbox;
    if (byInbox.has(inbox)) byInbox.set(inbox, null);
    else byInbox.set(inbox, f.sharedInbox ? null : f.actorUri);
  }

  // Deliver in parallel (but limit concurrency)
  const inboxList = Array.from(byInbox.keys());
  const results = await Promise.allSettled(
    inboxList.map((inbox) => deliverActivity(inbox, activity, { actorUri: byInbox.get(inbox) })),
  );

  // Enqueue failures for retry. deliverActivity resolves (never rejects) with
  // { ok:false } on failure; handle a rejection defensively too.
  const activityId = typeof activity.id === "string" ? activity.id : null;
  if (activityId) {
    const failures: { inbox: string; error: string; permanent?: boolean }[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && !r.value.ok) {
        failures.push({
          inbox: inboxList[i],
          error: r.value.error || `status ${r.value.status}`,
          permanent: r.value.permanent,
        });
      } else if (r.status === "rejected") {
        failures.push({ inbox: inboxList[i], error: String(r.reason) });
      }
    });
    if (failures.length > 0) {
      await enqueueFailedDeliveries(activityId, JSON.stringify(activity), failures).catch(() => {});
    }
  }
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
 * Returns the signing key's OWNER actor URI (host-validated — see the return
 * site). Callers must compare this to the activity's `actor` field with
 * `actorMatchesSigner` (exact match) to prevent cross-actor spoofing (C5/#209).
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
  let actor: { publicKey?: { publicKeyPem?: string; owner?: string }; id?: string };
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

  // Bind to the key's OWNER so the caller can require it == the activity actor
  // (#209 — a host-only match let any actor on the same instance forge as
  // another). Prefer the key's declared `owner`, else the fetched actor's `id`,
  // else the URL we fetched from. Crucially, only trust an owner on the SAME
  // host as the key's own URL: a fetched document must not be able to claim an
  // owner on a *different* host (that would let evil.example serve a doc
  // declaring `owner: victim.social/celebrity`). A cross-host claim falls back
  // to the fetch URL, which then can't match the claimed actor.
  const claimedOwner = actor.publicKey?.owner || actor.id || actorUriFromKey;
  const owner = sameHost(claimedOwner, actorUriFromKey) ? claimedOwner : actorUriFromKey;
  return { valid: true, actorUri: owner };
}

/** True if two URIs resolve to the same host (case-insensitive). Internal. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Returns true if the verified signer (the key's owner, from
 * verifyIncomingSignature) is the actor claimed in the activity body.
 *
 * EXACT URI match (not host-only): the signer must BE the claimed actor, so an
 * actor can't act on behalf of a different actor on the same host (#209). Hosts
 * are compared case-insensitively and a trailing slash is ignored, but the path
 * must match exactly — `.../users/alice` ≠ `.../users/bob`.
 */
export function actorMatchesSigner(signerUri: string, claimedActorUri: string): boolean {
  try {
    const norm = (u: string) => {
      const x = new URL(u);
      // Character scan, not /\/+$/. That regex backtracks quadratically on a
      // long run of slashes, and this runs on the signer URI of EVERY inbound
      // activity — i.e. on a value a remote server fully controls
      // (js/polynomial-redos).
      const path = x.pathname;
      let end = path.length;
      while (end > 0 && path.charCodeAt(end - 1) === 47 /* "/" */) end--;
      return `${x.protocol}//${x.host.toLowerCase()}${path.slice(0, end)}`;
    };
    return norm(signerUri) === norm(claimedActorUri);
  } catch {
    return false;
  }
}
