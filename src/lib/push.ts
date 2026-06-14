import webpush from "web-push";
import { prisma } from "./db";
import { siteConfig } from "@/../site.config";

/**
 * Web Push (PWA notifications) for the single site owner.
 *
 * FediHome is single-user, so every PushSubscription row belongs to the admin.
 * `sendPushToOwner` fans a payload out to all the owner's registered devices and
 * prunes endpoints the push service reports as gone (404/410).
 *
 * Dormant until VAPID keys are set in .env.local (gitignored):
 *   VAPID_PUBLIC_KEY  — also handed to the browser as applicationServerKey
 *   VAPID_PRIVATE_KEY — server-only signing key
 *   VAPID_SUBJECT     — contact, e.g. mailto:you@example.com
 * Generate a keypair with:  npx web-push generate-vapid-keys
 */

const PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT =
  process.env.VAPID_SUBJECT ||
  (siteConfig.contactEmail ? `mailto:${siteConfig.contactEmail}` : `mailto:admin@${siteConfig.fediDomain}`);

let configured = false;
function ensureConfigured(): boolean {
  if (!PUBLIC || !PRIVATE) return false;
  if (!configured) {
    webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
    configured = true;
  }
  return true;
}

/** True when VAPID keys are present so push can actually be sent. */
export function pushConfigured(): boolean {
  return !!(PUBLIC && PRIVATE);
}

/** The VAPID public key the browser needs to subscribe. Safe to expose. */
export function getVapidPublicKey(): string {
  return PUBLIC;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string; // where notificationclick navigates (default "/timeline")
  tag?: string; // collapse key — a new push with the same tag replaces the old
  icon?: string; // small icon (default app icon)
  type?: string; // category, e.g. "like" | "follow" — for click routing/analytics
}

const FAILURE_PRUNE_THRESHOLD = 8;

/**
 * Send a notification to every device the owner enabled. Never throws — push is
 * best-effort and must not break the request that triggered it. Callers should
 * still `void sendPushToOwner(...).catch(() => {})` so a rejected promise from an
 * unexpected place can't surface as an unhandled rejection.
 */
export async function sendPushToOwner(payload: PushPayload): Promise<void> {
  try {
    if (!ensureConfigured()) return; // keys not set — silently no-op

    const subs = await prisma.pushSubscription.findMany();
    if (subs.length === 0) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || "/timeline",
      tag: payload.tag,
      icon: payload.icon || "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      type: payload.type || null,
    });

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            { TTL: 60 * 60 * 24 }
          );
          await prisma.pushSubscription
            .update({ where: { id: s.id }, data: { lastUsedAt: new Date(), failures: 0 } })
            .catch(() => {});
        } catch (err) {
          const statusCode =
            err && typeof err === "object" && "statusCode" in err
              ? Number((err as { statusCode: unknown }).statusCode)
              : 0;

          if (statusCode === 404 || statusCode === 410) {
            // Endpoint permanently gone — drop it.
            await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
          } else if (s.failures + 1 >= FAILURE_PRUNE_THRESHOLD) {
            await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
          } else {
            await prisma.pushSubscription
              .update({ where: { id: s.id }, data: { failures: { increment: 1 } } })
              .catch(() => {});
          }
        }
      })
    );
  } catch {
    // swallow — push must never break the triggering request
  }
}
