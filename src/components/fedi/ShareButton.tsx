"use client";

import { useState } from "react";

/**
 * Share a post's originating URL. On macOS/iOS (and Android) the Web Share API
 * opens the native share sheet; everywhere else it copies the link to the
 * clipboard with brief "Copied!" feedback.
 */
export default function ShareButton({
  url,
  title,
  className = "",
}: {
  url: string | null;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  if (!url) return null;

  const onShare = async () => {
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ url, title });
      } catch {
        // user cancelled the share sheet, or it failed — do nothing
      }
      return;
    }
    // No Web Share API → copy the link.
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.open(url, "_blank", "noopener");
    }
  };

  return (
    <button
      onClick={onShare}
      title="Share / copy link to original"
      aria-label="Share post"
      className={`inline-flex items-center gap-1 text-gray-500 hover:text-accent-400 transition-colors ${className}`}
    >
      {copied ? (
        <span className="text-[10px] text-accent-400">Copied!</span>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 8.25H7.5a2.25 2.25 0 00-2.25 2.25v9a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25H15m0-3l-3-3m0 0l-3 3m3-3V15"
          />
        </svg>
      )}
    </button>
  );
}
