import { describe, it, expect } from "vitest";
import { resolvePushStatus, subKeyOf } from "@/lib/push-client";

/**
 * Push enrollment state (#59). The bug this locks down: the bell showed
 * "Enable phone notifications" on a server with no VAPID keypair, and clicking it
 * failed with an opaque "push not configured on server" — a dead end, with the
 * panel that fixes it somewhere else entirely. `needs-keys` is what makes that
 * state visible (and one-click fixable) instead.
 *
 * The other half is the rotation trap: a PushSubscription bound to a rotated key
 * still looks healthy to getSubscription() but can never receive a send again,
 * so it must never resolve to "on".
 */

const KEY_A = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const KEY_B = "BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo4M0gs0i1oEKgPpWC5cW8OCzVrOQRv-1npXRWk8udnW3oYhIO4475rds";

describe("resolvePushStatus — server has no keypair", () => {
  it("reports needs-keys when the server is unconfigured", () => {
    expect(
      resolvePushStatus({ configured: false, serverKey: "", serverCount: 0, subKey: null }),
    ).toBe("needs-keys");
  });

  it("reports needs-keys even when this device still holds a subscription", () => {
    // The stale local subscription must not mask an unconfigured server.
    expect(
      resolvePushStatus({ configured: false, serverKey: "", serverCount: 0, subKey: KEY_A }),
    ).toBe("needs-keys");
  });

  it("treats configured-but-keyless as needs-keys (never offers a subscribe with no key)", () => {
    expect(
      resolvePushStatus({ configured: true, serverKey: "", serverCount: 0, subKey: null }),
    ).toBe("needs-keys");
  });
});

describe("resolvePushStatus — server configured", () => {
  it("is ready when this device has no subscription", () => {
    expect(
      resolvePushStatus({ configured: true, serverKey: KEY_A, serverCount: 0, subKey: null }),
    ).toBe("ready");
  });

  it("is on when the subscription matches the server's current key", () => {
    expect(
      resolvePushStatus({ configured: true, serverKey: KEY_A, serverCount: 1, subKey: KEY_A }),
    ).toBe("on");
  });

  it("is ready — NOT on — when the subscription is bound to a rotated key", () => {
    // The silent-death case: looks subscribed, can never receive a send.
    expect(
      resolvePushStatus({ configured: true, serverKey: KEY_B, serverCount: 1, subKey: KEY_A }),
    ).toBe("ready");
  });

  it("is ready when the server holds zero subscriptions, even on a key match", () => {
    // Keys were rotated and every subscription purged from under this device.
    expect(
      resolvePushStatus({ configured: true, serverKey: KEY_A, serverCount: 0, subKey: KEY_A }),
    ).toBe("ready");
  });
});

describe("subKeyOf", () => {
  it("returns '' for a missing key", () => {
    expect(subKeyOf(null)).toBe("");
    expect(subKeyOf(undefined)).toBe("");
  });

  it("round-trips a base64url key through the same encoding the server uses", () => {
    // Decode KEY_A the way the browser stores it, then re-encode: must match, or
    // every comparison against the server's public key is a false mismatch.
    const b64 = KEY_A.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    expect(subKeyOf(bytes.buffer)).toBe(KEY_A);
  });

  it("emits no base64 padding or +/ characters (must match the server's base64url)", () => {
    const key = subKeyOf(new Uint8Array([251, 255, 254, 0, 62, 63]).buffer);
    expect(key).not.toMatch(/[+/=]/);
  });
});
