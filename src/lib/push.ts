import webpush from "web-push";
import { prisma } from "./db";
import { computeNotifications } from "./notifications";
import { ensurePushConfigured } from "./push-config";

/**
 * Web Push (PWA notifications) for the single site owner.
 *
 * FediHome is single-user, so every PushSubscription row belongs to the admin.
 * `sendPushToOwner` fans a payload out to all the owner's registered devices and
 * prunes endpoints the push service reports as gone (404/410).
 *
 * The VAPID keys themselves (settable in the admin panel or via VAPID_* env)
 * live in push-config.ts; `ensurePushConfigured()` re-inits web-push whenever
 * they change, so this module just sends.
 */

export interface PushPayload {
  title: string;
  body: string;
  url?: string; // where notificationclick navigates (default "/timeline")
  tag?: string; // collapse key — a new push with the same tag replaces the old
  icon?: string; // small icon (default app icon)
  type?: string; // category, e.g. "like" | "follow" — for click routing/analytics
  count?: number; // authoritative unread total; if omitted, computed from the bell
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
    if (!(await ensurePushConfigured())) return; // keys not set — silently no-op

    const subs = await prisma.pushSubscription.findMany();
    if (subs.length === 0) return;

    // Authoritative unread total so the service worker sets the badge to the real
    // bell count instead of blind-incrementing per push (#103). Best-effort: if it
    // can't be computed, leave it undefined and sw.js keeps its +1 fallback.
    const count =
      typeof payload.count === "number"
        ? payload.count
        : await computeNotifications()
            .then((r) => r.count)
            .catch(() => undefined);

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || "/timeline",
      tag: payload.tag,
      icon: payload.icon || "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      type: payload.type || null,
      count,
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
