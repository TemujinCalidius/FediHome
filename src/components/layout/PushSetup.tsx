"use client";

import { useEffect, useState } from "react";

/**
 * Web Push enrollment UI, shown in the NotificationBell dropdown (admin-only).
 *
 * Registers /sw.js, then offers "Enable phone notifications" which requests
 * permission + subscribes via the VAPID public key and stores the subscription
 * server-side. On iOS, push only works from a home-screen install, so when not
 * running standalone we show Add-to-Home-Screen guidance instead.
 *
 * Dormant until the server has VAPID keys set (the enable button reports it).
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

type Status = "loading" | "unsupported" | "ios-needs-install" | "ready" | "on" | "denied";

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
        if (!cancelled) setStatus(existing ? "on" : "ready");
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
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "denied" : "ready");
        setBusy(false);
        return;
      }

      const keyRes = await fetch("/api/push");
      if (!keyRes.ok) throw new Error("could not load push config");
      const { publicKey, configured } = await keyRes.json();
      if (!configured || !publicKey) throw new Error("push not configured on server");

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
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
