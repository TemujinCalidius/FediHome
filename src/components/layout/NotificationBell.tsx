"use client";

import { useState, useEffect, useRef } from "react";
import PushSetup from "./PushSetup";

/**
 * Mirror the unread count onto the installed app's icon badge (Dock on macOS /
 * home screen elsewhere) and keep the service worker's persisted counter in sync
 * so the badge is right even when a push arrives while the app is closed.
 * No-ops in browsers/contexts without the Badging API.
 */
function syncAppBadge(count: number) {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) nav.setAppBadge?.(count).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  } catch {
    /* ignore */
  }
  try {
    navigator.serviceWorker?.ready
      .then((reg) => reg.active?.postMessage({ type: "setBadge", count }))
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

interface NotificationItem {
  id: string;
  type: "like" | "boost" | "reply" | "follow" | "comment" | "dm" | "update";
  source: string;
  actor: string;
  actorUrl: string | null;
  avatarUrl: string | null;
  summary: string;
  targetUrl: string | null;
  maintenanceId: string | null;
  createdAt: string;
}

const typeEmojis: Record<string, string> = {
  like: "\u2764\uFE0F",
  boost: "\uD83D\uDD01",
  reply: "\uD83D\uDCAC",
  follow: "\uD83D\uDC64",
  comment: "\u270D\uFE0F",
  dm: "\u2709\uFE0F",
  update: "\uD83D\uDD27",
};

const sourceColors: Record<string, string> = {
  fedi: "text-accent-400",
  bluesky: "text-blue-400",
  guest: "text-gray-400",
  maintenance: "text-amber-400",
};

type Category = "all" | "like" | "boost" | "reply" | "follow" | "comment" | "dm" | "update";

const categories: { key: Category; label: string }[] = [
  { key: "all", label: "All" },
  { key: "like", label: "Likes" },
  { key: "boost", label: "Boosts" },
  { key: "reply", label: "Replies" },
  { key: "follow", label: "Follows" },
  { key: "comment", label: "Comments" },
  { key: "dm", label: "Messages" },
  { key: "update", label: "Updates" },
];

function CategoryIcon({ type, className }: { type: Category; className?: string }) {
  const cls = className || "w-4 h-4";
  switch (type) {
    case "all":
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
      );
    case "like":
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
        </svg>
      );
    case "boost":
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
        </svg>
      );
    case "reply":
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
      );
    case "follow":
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
        </svg>
      );
    case "comment":
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
        </svg>
      );
    case "dm":
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
        </svg>
      );
    case "update":
      return (
        <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
        </svg>
      );
  }
}

export default function NotificationBell() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const [activeCategory, setActiveCategory] = useState<Category>("all");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = async () => {
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) {
        const data = await res.json();
        setCount(data.count || 0);
        syncAppBadge(data.count || 0);
        if (data.items) setItems(data.items);
        if (data.categoryCounts) setCategoryCounts(data.categoryCounts);
        setLoaded(true);
      }
    } catch {
      // silently fail
    }
  };

  useEffect(() => {
    fetchNotifications();
    // Live: poll while visible and refresh instantly when the app regains focus
    // (the common case for an always-open Dock/home-screen PWA). Paused while
    // hidden to save resources — Web Push handles alerts then.
    const tick = () => {
      if (typeof document !== "undefined" && !document.hidden) fetchNotifications();
    };
    const interval = setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    // Instant: the service worker pings us the moment a push arrives.
    const onSwMsg = (e: MessageEvent) => {
      if (e.data?.type === "push") fetchNotifications();
    };
    navigator.serviceWorker?.addEventListener("message", onSwMsg);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      navigator.serviceWorker?.removeEventListener("message", onSwMsg);
    };
  }, []);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Capture "now" in an effect (not during render) so relative times stay pure and
  // hydration-safe; refresh it each minute.
  const [now, setNow] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync client-only time after mount
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  if (!loaded) return null;

  const timeAgo = (dateStr: string) => {
    const diff = now - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  const markAllRead = async () => {
    try {
      await fetch("/api/notifications", { method: "POST" });
      setCount(0);
      setCategoryCounts({});
      syncAppBadge(0);
    } catch {
      // silently fail
    }
  };

  const handleItemClick = (item: NotificationItem) => {
    setOpen(false);
    if (item.type === "follow" && item.actorUrl) {
      window.open(item.actorUrl, "_blank");
      return;
    }
    if (item.type === "update" && item.targetUrl) {
      window.open(item.targetUrl, "_blank");
      return;
    }
    if (item.targetUrl) {
      window.location.href = item.targetUrl;
    }
  };

  const handleMaintenanceAction = async (
    e: React.MouseEvent,
    id: string,
    field: "applied" | "dismissed",
  ) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/maintenance/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: true }),
      });
      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.maintenanceId !== id));
        fetchNotifications();
      }
    } catch {
      // silently fail
    }
  };

  const displayItems = activeCategory === "all"
    ? items
    : items.filter((i) => i.type === activeCategory);

  const totalUnreadForCategory = (key: Category) => {
    if (key === "all") return count;
    return categoryCounts[key] || 0;
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative text-gray-500 hover:text-accent-400 transition-colors"
        title="Notifications"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
          />
        </svg>
        {count > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 flex items-center justify-center bg-red-500 text-white text-[9px] font-bold rounded-full px-1">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-x-2 top-14 sm:absolute sm:inset-x-auto sm:right-0 sm:top-8 sm:w-[460px] bg-surface-900 border border-surface-600/30 rounded-xl shadow-2xl shadow-black/50 z-50 overflow-hidden flex flex-col">
          {/* Header */}
          <div className="px-4 py-3 border-b border-surface-700 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Notifications</h3>
            <div className="flex items-center gap-3">
              {count > 0 && (
                <button
                  onClick={markAllRead}
                  className="text-[10px] text-accent-400 hover:text-accent-300 transition-colors"
                >
                  Mark all read
                </button>
              )}
            </div>
          </div>

          {/* Body: list + sidebar */}
          <div className="flex min-h-0" style={{ maxHeight: "28rem" }}>
            {/* Notification list */}
            <div className="flex-1 overflow-y-auto">
              {displayItems.length === 0 ? (
                <div className="p-6 text-center">
                  <p className="text-xs text-gray-600">
                    {activeCategory === "all" ? "No notifications" : `No ${categories.find((c) => c.key === activeCategory)?.label?.toLowerCase() || ""}`}
                  </p>
                </div>
              ) : (
                displayItems.map((item) => (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleItemClick(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleItemClick(item);
                      }
                    }}
                    className="w-full flex items-start gap-3 px-4 py-3 hover:bg-surface-800/50 transition-colors border-b border-surface-800/50 last:border-0 text-left cursor-pointer"
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      {item.avatarUrl ? (
                        <img src={item.avatarUrl} alt="" className="w-8 h-8 rounded-full" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-surface-700 flex items-center justify-center text-sm">
                          {typeEmojis[item.type] || ""}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-300">
                        <span className="font-semibold text-white">{item.actor}</span>{" "}
                        {item.summary}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-gray-600">{timeAgo(item.createdAt)}</span>
                        <span className={`text-[10px] ${sourceColors[item.source] || "text-gray-500"}`}>
                          {item.source}
                        </span>
                        <span className="text-[10px]">{typeEmojis[item.type]}</span>
                      </div>
                    </div>
                    {item.type === "follow" && (
                      <span className="text-[10px] text-gray-600 flex-shrink-0 mt-1">
                        view profile
                      </span>
                    )}
                    {item.type === "update" && item.maintenanceId && (
                      <div className="flex flex-col gap-1 flex-shrink-0">
                        <button
                          type="button"
                          title="Mark applied"
                          onClick={(e) => handleMaintenanceAction(e, item.maintenanceId!, "applied")}
                          className="w-6 h-6 flex items-center justify-center rounded text-green-500 hover:bg-green-500/20 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          title="Dismiss"
                          onClick={(e) => handleMaintenanceAction(e, item.maintenanceId!, "dismissed")}
                          className="w-6 h-6 flex items-center justify-center rounded text-gray-500 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Category sidebar */}
            <div className="w-11 flex-shrink-0 border-l border-surface-700 flex flex-col items-center py-2 gap-1 overflow-y-auto">
              {categories.map((cat) => {
                const isActive = activeCategory === cat.key;
                const unread = totalUnreadForCategory(cat.key);
                return (
                  <button
                    key={cat.key}
                    onClick={() => setActiveCategory(cat.key)}
                    className={`relative w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
                      isActive
                        ? "bg-accent-500/20 text-accent-400"
                        : "text-gray-500 hover:text-gray-300 hover:bg-surface-800/50"
                    }`}
                    title={cat.label}
                  >
                    <CategoryIcon type={cat.key} className="w-4 h-4" />
                    {unread > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 flex items-center justify-center bg-red-500 text-white text-[8px] font-bold rounded-full px-0.5">
                        {unread > 99 ? "99" : unread}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          {items.length > 0 && (
            <a
              href="/timeline"
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 text-center text-xs text-accent-400 hover:bg-surface-800/50 border-t border-surface-700 transition-colors"
            >
              View all in Timeline
            </a>
          )}

          {/* Web Push enrollment (PWA phone notifications) */}
          <PushSetup />
        </div>
      )}
    </div>
  );
}
