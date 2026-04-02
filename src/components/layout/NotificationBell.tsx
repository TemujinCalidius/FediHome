"use client";

import { useState, useEffect, useRef } from "react";

interface NotificationItem {
  id: string;
  type: "like" | "boost" | "reply" | "follow" | "comment" | "dm";
  source: string;
  actor: string;
  actorUrl: string | null;
  avatarUrl: string | null;
  summary: string;
  targetUrl: string | null;
  createdAt: string;
}

const typeIcons: Record<string, string> = {
  like: "\u2764\uFE0F",
  boost: "\uD83D\uDD01",
  reply: "\uD83D\uDCAC",
  follow: "\uD83D\uDC64",
  comment: "\u270D\uFE0F",
  dm: "\u2709\uFE0F",
};

const sourceColors: Record<string, string> = {
  fedi: "text-accent-400",
  bluesky: "text-blue-400",
  guest: "text-gray-400",
};

export default function NotificationBell() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = async () => {
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) {
        const data = await res.json();
        setCount(data.count || 0);
        if (data.items) setItems(data.items);
        setLoaded(true);
      }
    } catch {
      // silently fail
    }
  };

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 60000);
    return () => clearInterval(interval);
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!loaded) return null;

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
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
    } catch {
      // silently fail
    }
  };

  const handleItemClick = (item: NotificationItem) => {
    setOpen(false);
    // For follows, go to their profile
    if (item.type === "follow" && item.actorUrl) {
      window.open(item.actorUrl, "_blank");
      return;
    }
    // For everything else, go to target
    if (item.targetUrl) {
      window.location.href = item.targetUrl;
    }
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
        <div className="absolute right-0 top-8 w-80 bg-surface-900 border border-surface-600/30 rounded-xl shadow-2xl shadow-black/50 z-50 overflow-hidden">
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

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="p-6 text-center">
                <p className="text-xs text-gray-600">No notifications</p>
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleItemClick(item)}
                  className="w-full flex items-start gap-3 px-4 py-3 hover:bg-surface-800/50 transition-colors border-b border-surface-800/50 last:border-0 text-left"
                >
                  <div className="flex-shrink-0 mt-0.5">
                    {item.avatarUrl ? (
                      <img src={item.avatarUrl} alt="" className="w-8 h-8 rounded-full" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-surface-700 flex items-center justify-center text-sm">
                        {typeIcons[item.type] || ""}
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
                      <span className="text-[10px]">{typeIcons[item.type]}</span>
                    </div>
                  </div>
                  {item.type === "follow" && (
                    <span className="text-[10px] text-gray-600 flex-shrink-0 mt-1">
                      view profile
                    </span>
                  )}
                </button>
              ))
            )}
          </div>

          {items.length > 0 && (
            <a
              href="/timeline"
              onClick={() => setOpen(false)}
              className="block px-4 py-2.5 text-center text-xs text-accent-400 hover:bg-surface-800/50 border-t border-surface-700 transition-colors"
            >
              View all in Timeline
            </a>
          )}
        </div>
      )}
    </div>
  );
}
