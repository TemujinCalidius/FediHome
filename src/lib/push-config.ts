import webpush from "web-push";
import { prisma } from "./db";
import { siteConfig } from "@/../site.config";
import { encryptSecret, decryptSecret } from "./secret-box";
import { getRuntimeSiteConfig } from "./site-settings";

/**
 * Web-push VAPID configuration (#59), settable in the admin panel so PWA push
 * needs no `.env` editing. Mirrors the encrypted-secret pattern used for the
 * Tinylytics API key (see analytics-secret.ts): stored as `SiteSetting` rows
 * under the `integration.push.*` namespace, DELIBERATELY outside
 * `SITE_CONFIG_KEYS` so the site-config admin GET / applySiteConfig never touch
 * them. The public key + subject are public (the browser needs the public key);
 * the private signing key is AES-256-GCM-encrypted at rest.
 *
 * Env fallback (`VAPID_*`) throughout, so instances configured the old way keep
 * working; a saved DB key takes precedence.
 */

const PUB = "integration.push.publicKey";
const PRIV = "integration.push.privateKey"; // encrypted
const SUBJ = "integration.push.subject";

async function readRows(): Promise<Record<string, string>> {
  try {
    const rows = await prisma.siteSetting.findMany({ where: { key: { in: [PUB, PRIV, SUBJ] } } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {}; // DB down/mid-migration → fall back to env
  }
}

/** The VAPID `mailto:` subject — the web-set contact email, else the fedi domain. */
async function defaultSubject(): Promise<string> {
  let email = "";
  try {
    email = (await getRuntimeSiteConfig()).contact.email || "";
  } catch {
    /* DB down → env/config fallback below */
  }
  email = email || siteConfig.contactEmail || "";
  return email ? `mailto:${email}` : `mailto:admin@${siteConfig.fediDomain}`;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * The resolved VAPID triple: the saved DB values (private key decrypted) if
 * complete, else the env vars. `null` when neither source has a full keypair
 * (push then stays dormant).
 */
export async function getVapidConfig(): Promise<VapidConfig | null> {
  const o = await readRows();
  const dbPriv = o[PRIV] ? decryptSecret(o[PRIV]) : null;
  if (o[PUB] && dbPriv) {
    return { publicKey: o[PUB], privateKey: dbPriv, subject: o[SUBJ] || (await defaultSubject()) };
  }
  const ePub = process.env.VAPID_PUBLIC_KEY;
  const ePriv = process.env.VAPID_PRIVATE_KEY;
  if (ePub && ePriv) {
    return { publicKey: ePub, privateKey: ePriv, subject: process.env.VAPID_SUBJECT || (await defaultSubject()) };
  }
  return null;
}

/** The public key the browser needs to subscribe. Safe to expose; "" when unset. */
export async function getVapidPublicKey(): Promise<string> {
  return (await getVapidConfig())?.publicKey ?? "";
}

/** Whether push can actually be sent (a full keypair exists in DB or env). */
export async function pushConfigured(): Promise<boolean> {
  return !!(await getVapidConfig());
}

/** Admin-panel status — never returns the private key. */
export async function getPushKeyStatus(): Promise<{ configured: boolean; source: "db" | "env" | null; subject: string }> {
  const o = await readRows();
  const db = !!(o[PUB] && o[PRIV] && decryptSecret(o[PRIV]));
  const env = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const subject = o[SUBJ] || process.env.VAPID_SUBJECT || (await defaultSubject());
  return { configured: db || env, source: db ? "db" : env ? "env" : null, subject };
}

/**
 * Rotating VAPID keys invalidates EVERY existing subscription — each is bound to
 * the old `applicationServerKey` and can never receive a send signed by a new
 * key. So any key change must drop them all; devices re-enrol against the new
 * key (the client detects the mismatch and re-subscribes).
 */
async function purgeSubscriptions(): Promise<void> {
  await prisma.pushSubscription.deleteMany({}).catch(() => {});
}

/** Save a VAPID triple (private key encrypted), purging old subscriptions. */
export async function setVapidKeys(
  publicKey: string,
  privateKey: string,
  subject?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const enc = encryptSecret(privateKey);
  if (!enc) return { ok: false, error: "Encryption unavailable — ADMIN_SECRET is not set." };
  await prisma.siteSetting.upsert({ where: { key: PUB }, update: { value: publicKey }, create: { key: PUB, value: publicKey } });
  await prisma.siteSetting.upsert({ where: { key: PRIV }, update: { value: enc }, create: { key: PRIV, value: enc } });
  if (subject) {
    await prisma.siteSetting.upsert({ where: { key: SUBJ }, update: { value: subject }, create: { key: SUBJ, value: subject } });
  }
  await purgeSubscriptions();
  invalidatePushConfig();
  return { ok: true };
}

/** Generate a fresh keypair server-side, save it (purging old subscriptions), return the public key. */
export async function generateVapidKeys(subject?: string): Promise<{ ok: true; publicKey: string } | { ok: false; error: string }> {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const r = await setVapidKeys(publicKey, privateKey, subject);
  return r.ok ? { ok: true, publicKey } : r;
}

/** Remove the DB override (reverts to env if set), purging subscriptions. */
export async function clearVapidKeys(): Promise<void> {
  await prisma.siteSetting.deleteMany({ where: { key: { in: [PUB, PRIV, SUBJ] } } });
  await purgeSubscriptions();
  invalidatePushConfig();
}

/* --- web-push global re-init ------------------------------------------------
 * `webpush.setVapidDetails` sets PROCESS-GLOBAL state, so a one-shot boolean
 * would keep signing with the old key after a rotation. Instead we track a
 * fingerprint of the active keys and re-init whenever it changes. getVapidConfig
 * reads fresh each call (push isn't a hot path), so a rotation in ANY process is
 * picked up on that process's next send. */
let currentFingerprint = "";
export function invalidatePushConfig(): void {
  currentFingerprint = "";
}

/** Ensure web-push is configured with the CURRENT keys; re-inits on change. False when unset. */
export async function ensurePushConfigured(): Promise<boolean> {
  const c = await getVapidConfig();
  if (!c) return false;
  const fp = `${c.publicKey}:${c.subject}`;
  if (fp !== currentFingerprint) {
    webpush.setVapidDetails(c.subject, c.publicKey, c.privateKey);
    currentFingerprint = fp;
  }
  return true;
}
