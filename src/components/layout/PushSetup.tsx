"use client";

import { useEffect, useState } from "react";
import { resolvePushStatus, subKeyOf } from "@/lib/push-client";

/**
 * Web Push enrollment UI, shown in the NotificationBell dropdown (admin-only).
 *
 * Registers /sw.js, then offers "Enable phone notifications" which requests
 * permission + subscribes via the VAPID public key and stores the subscription
 * server-side. On iOS, push only works from a home-screen install, so when not
 * running standalone we show Add-to-Home-Screen guidance instead.
 *
 * If the server has no VAPID keypair yet, this generates one first — the bell is
 * owner-only and /api/admin/push-keys re-checks that, so the whole thing is one
 * click with no .env editing (#59). It used to show the enable button regardless
 * and fail with an opaque "push not configured on server", which left push
 * unreachable on a fresh install.
 */

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

type PushInfo = { configured: boolean; publicKey: string; count: number };

/** `GET /api/push` — the server's key + how many devices it currently knows about. */
async function fetchPushInfo(): Promise<PushInfo | null> {
  try {
    const res = await fetch("/api/push");
    if (!res.ok) return null;
    const d = await res.json();
    return {
      configured: !!d?.configured,
      publicKey: typeof d?.publicKey === "string" ? d.publicKey : "",
      count: typeof d?.count === "number" ? d.count : 0,
    };
  } catch {
    return null;
  }
}

type Status = "loading" | "unsupported" | "ios-needs-install" | "needs-keys" | "ready" | "on" | "denied";

export default function PushSetup() {
  const [status, setStatus] = useState<Status>("loading");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const ua = navigator.userAgent || "";
      const isIOS =
        /iphone|ipad|ipod/i.test(ua) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const standalone =
        window.matchMedia?.("(display-mode: standalone)")?.matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true;

      const hasSW = "serviceWorker" in navigator;
      const hasPush = "PushManager" in window;
      const hasNotif = "Notification" in window;

      // iOS Safari hides PushManager until the site is installed to the Home Screen.
      if (isIOS && !standalone) {
        if (!cancelled) setStatus("ios-needs-install");
        return;
      }
      if (!hasSW || !hasPush || !hasNotif) {
        if (!cancelled) setStatus("unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setStatus("denied");
        return;
      }

      try {
        const reg =
          (await navigator.serviceWorker.getRegistration()) ||
          (await navigator.serviceWorker.register("/sw.js"));
        const existing = await reg.pushManager.getSubscription();
        // Always ask the server, even with no local subscription: that's the only
        // way to learn it has no keypair yet, and showing "Enable" in that state
        // is a dead end (#59). Don't trust a bare subscription either — after a
        // key rotation it's bound to a dead key and silently receives nothing.
        const info = await fetchPushInfo();
        if (cancelled) return;
        setStatus(
          info
            ? resolvePushStatus({
                configured: info.configured,
                serverKey: info.publicKey,
                serverCount: info.count,
                subKey: existing ? subKeyOf(existing.options?.applicationServerKey) : null,
              })
            : // Couldn't reach the server — offer the button and let the click
              // report the real reason rather than guessing a state.
              "ready",
        );
      } catch {
        if (!cancelled) setStatus("unsupported");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const enable = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // Must stay first and un-awaited-before: the permission prompt has to run
      // inside the user gesture (Safari enforces this strictly).
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "denied" : status);
        setBusy(false);
        return;
      }

      let info = await fetchPushInfo();
      if (!info) throw new Error("Couldn't load the push settings.");

      // No keypair on the server yet — make one, rather than dead-ending on
      // "push not configured". Safe to do from here: this menu is owner-only,
      // /api/admin/push-keys re-checks admin + origin, and with no keys there
      // are no existing subscriptions for the generate to purge.
      if (!info.configured || !info.publicKey) {
        setMsg("Setting up push on the server…");
        const gen = await fetch("/api/admin/push-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "generate" }),
        });
        const genBody = await gen.json().catch(() => null);
        // Surface the server's own reason (e.g. ADMIN_SECRET missing, so the
        // private key can't be encrypted at rest) instead of a generic failure.
        if (!gen.ok) throw new Error(genBody?.error || "Couldn't set up push on the server.");
        info = await fetchPushInfo();
        if (!info?.configured || !info.publicKey) {
          throw new Error("Push keys were created but couldn't be read back.");
        }
      }
      const publicKey = info.publicKey;

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // If an existing subscription is bound to a DIFFERENT (rotated) key, drop it
      // and re-subscribe — the browser throws InvalidStateError if you subscribe
      // with a new applicationServerKey while an old subscription exists.
      if (sub && subKeyOf(sub.options?.applicationServerKey) !== publicKey) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
      });
      if (!res.ok) throw new Error("could not save subscription");

      setStatus("on");
      setMsg("Enabled on this device.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setStatus("ready");
      setMsg("Turned off on this device.");
    } catch {
      setMsg("Could not turn off.");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      setMsg(res.ok ? "Test sent — check your device." : "Test failed.");
    } catch {
      setMsg("Test failed.");
    } finally {
      setBusy(false);
    }
  };

  if (status === "loading") return null;

  return (
    <div className="px-4 py-2.5 border-t border-surface-700 text-[11px] text-gray-400">
      {status === "ios-needs-install" && (
        <p className="leading-relaxed">
          📲 To get push on your iPhone: tap the{" "}
          <span className="text-gray-200">Share</span> icon →{" "}
          <span className="text-gray-200">Add to Home Screen</span>, then open the app
          from your Home Screen and enable notifications here.
        </p>
      )}

      {status === "unsupported" && (
        <p>Push notifications aren&apos;t supported in this browser.</p>
      )}

      {status === "denied" && (
        <p>
          Notifications are blocked. Allow them for this site in your browser/OS
          settings, then reload.
        </p>
      )}

      {status === "needs-keys" && (
        <div>
          <button
            onClick={enable}
            disabled={busy}
            className="text-accent-400 hover:text-accent-300 transition-colors disabled:opacity-50"
          >
            🔔 {busy ? "Setting up…" : "Set up phone notifications"}
          </button>
          <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
            One click — this creates your push keys on the server, then enables
            notifications on this device.
          </p>
        </div>
      )}

      {status === "ready" && (
        <button
          onClick={enable}
          disabled={busy}
          className="text-accent-400 hover:text-accent-300 transition-colors disabled:opacity-50"
        >
          🔔 {busy ? "Enabling…" : "Enable phone notifications"}
        </button>
      )}

      {status === "on" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-green-400">🔔 Phone notifications on</span>
          <div className="flex items-center gap-3">
            <button
              onClick={sendTest}
              disabled={busy}
              className="text-accent-400 hover:text-accent-300 transition-colors disabled:opacity-50"
            >
              Test
            </button>
            <button
              onClick={disable}
              disabled={busy}
              className="text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              Turn off
            </button>
          </div>
        </div>
      )}

      {msg && <p className="mt-1 text-[10px] text-gray-500">{msg}</p>}
    </div>
  );
}
