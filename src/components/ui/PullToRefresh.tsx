"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Pull-to-refresh for the installed PWA.
 *
 * iOS/Android home-screen apps run in standalone display mode, which disables the
 * browser's native pull-to-refresh — so we add our own. Only active in standalone
 * (a normal browser tab keeps its built-in pull-to-refresh). Engages only when the
 * page is scrolled to the very top and the user drags down; past the threshold on
 * release it reloads the current page.
 */

const THRESHOLD = 70; // px of pull needed to trigger
const MAX = 110; // px cap on the indicator travel
const RESISTANCE = 0.5; // drag-to-travel damping

export default function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const startY = useRef<number | null>(null);
  const dist = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (!standalone) return; // browser tabs already have native pull-to-refresh

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current || window.scrollY > 0) {
        startY.current = null;
        return;
      }
      startY.current = e.touches[0].clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (startY.current == null || refreshingRef.current) return;
      if (window.scrollY > 0) {
        startY.current = null;
        dist.current = 0;
        setPull(0);
        return;
      }
      const dy = e.touches[0].clientY - startY.current;
      if (dy > 0) {
        const d = Math.min(MAX, dy * RESISTANCE);
        dist.current = d;
        setPull(d);
        if (e.cancelable) e.preventDefault(); // suppress native rubber-band while pulling
      } else if (dist.current > 0) {
        dist.current = 0;
        setPull(0);
      }
    };

    const onEnd = () => {
      if (startY.current == null) return;
      startY.current = null;
      if (dist.current >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPull(THRESHOLD);
        setTimeout(() => window.location.reload(), 200);
      } else {
        dist.current = 0;
        setPull(0);
      }
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  if (pull <= 0 && !refreshing) return null;

  const progress = Math.min(1, pull / THRESHOLD);

  return (
    <div
      aria-hidden
      className="fixed left-1/2 top-0 z-[60] -translate-x-1/2 pointer-events-none"
      style={{ transform: `translate(-50%, ${pull}px)`, opacity: progress }}
    >
      <div className="mt-2 w-9 h-9 rounded-full bg-surface-800/90 border border-surface-600/50 shadow-lg shadow-black/30 backdrop-blur-sm flex items-center justify-center text-accent-400">
        <svg
          className={`w-5 h-5 ${refreshing ? "animate-spin" : ""}`}
          style={refreshing ? undefined : { transform: `rotate(${progress * 270}deg)` }}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992V4.356M3 12a9 9 0 0115.728-5.957L21 8m-9 13a9 9 0 01-8.728-6.957L3 16" />
        </svg>
      </div>
    </div>
  );
}
