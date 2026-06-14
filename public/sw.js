/* FediHome — service worker for Web Push + PWA.
 * Push-only (no offline caching); the site works online as normal.
 * iOS requires a service worker with a 'push' listener for home-screen PWA push. */

const SW_VERSION = "v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// --- App icon badge counter (Dock on macOS / home screen elsewhere) ---
// Persisted in IndexedDB so it survives the service worker being torn down
// between push events. The open app re-syncs this to the true unread count.
function badgeDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("badge", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getBadgeCount() {
  try {
    const db = await badgeDb();
    return await new Promise((resolve) => {
      const r = db.transaction("kv").objectStore("kv").get("count");
      r.onsuccess = () => resolve(typeof r.result === "number" ? r.result : 0);
      r.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}
async function setBadgeCount(n) {
  try {
    const db = await badgeDb();
    db.transaction("kv", "readwrite").objectStore("kv").put(n, "count");
  } catch {
    /* ignore */
  }
}
async function applyBadge(n) {
  await setBadgeCount(n);
  if (self.navigator && "setAppBadge" in self.navigator) {
    try {
      if (n > 0) await self.navigator.setAppBadge(n);
      else await self.navigator.clearAppBadge();
    } catch {
      /* unsupported / not installed — ignore */
    }
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data && event.data.text ? event.data.text() : "" };
  }

  const title = data.title || "New notification";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192.png",
    badge: data.badge || "/icons/icon-192.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || "/timeline", type: data.type || null },
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Bump the app-icon badge. If the server sent an authoritative count use it,
      // otherwise increment what we have (the open app corrects it on next sync).
      const next = typeof data.count === "number" ? data.count : (await getBadgeCount()) + 1;
      await applyBadge(next);
    })()
  );
});

// The open app posts the true unread count here so the Dock badge stays accurate.
self.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.type === "setBadge") {
    event.waitUntil(applyBadge(Math.max(0, msg.count | 0)));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/timeline";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              /* cross-origin or not allowed — ignore */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })()
  );
});
