/**
 * Web-push enrollment decision logic (#59), split out of `PushSetup.tsx`.
 *
 * The component is a client component and the test suite runs in the `node`
 * environment (no DOM, no jsdom), so the part worth testing — deciding whether
 * this device is genuinely subscribed — lives here as pure functions over
 * primitives. The component supplies the browser objects.
 *
 * The subtlety these encode: a `PushSubscription` object existing does NOT mean
 * push works. It is bound to the `applicationServerKey` it was created with, so
 * after a server-side VAPID rotation it can never receive a send again — while
 * still looking perfectly healthy to `getSubscription()`. Reporting that as "on"
 * is how a device silently goes dark.
 */

/**
 * base64url of a subscription's `applicationServerKey`, in the same encoding the
 * server reports its public key in — so the two can be compared directly.
 * `""` when there's no key to read.
 */
export function subKeyOf(raw: ArrayBuffer | ArrayBufferView | null | undefined): string {
  if (!raw) return "";
  const bytes =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * `needs-keys` — the server has no VAPID keypair, so nothing can be subscribed
 * yet (the owner sets one up in one click).
 * `on` — this device holds a subscription bound to the server's current key.
 * `ready` — push is available but this device isn't (or is no longer) enrolled.
 */
export type PushEnrollment = "needs-keys" | "on" | "ready";

export interface PushStatusInput {
  /** Whether the server has a full VAPID keypair (from `GET /api/push`). */
  configured: boolean;
  /** The server's current VAPID public key, base64url. */
  serverKey: string;
  /** How many subscriptions the server currently holds. */
  serverCount: number;
  /** base64url of this device's subscription key, or `null` when unsubscribed. */
  subKey: string | null;
}

export function resolvePushStatus({
  configured,
  serverKey,
  serverCount,
  subKey,
}: PushStatusInput): PushEnrollment {
  // No keypair on the server — the enable button would only ever fail, so say so
  // up front instead of letting the owner click into a dead end (#59).
  if (!configured || !serverKey) return "needs-keys";
  if (!subKey) return "ready";
  // The server holds no subscriptions: its keys were rotated + purged from under
  // us, so whatever this device still has is dead.
  if (serverCount === 0) return "ready";
  // Bound to a different (rotated) key — dead, however healthy it looks.
  return subKey === serverKey ? "on" : "ready";
}
