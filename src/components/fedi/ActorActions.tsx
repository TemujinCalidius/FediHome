"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Click a person, act on them — wherever they appear.
 *
 * Actor names used to be inert text everywhere except the owner's own timeline
 * feed. If someone replied to a post from Mastodon, there was no way to reach
 * them at all: no profile link, no follow, no block. Everything needed was
 * already in scope at the render site; nothing was wired to it.
 *
 * This wraps whatever trigger a surface wants (`children`) and opens a small
 * popup with the actions that make sense for that person. Follow/Unfollow/Block
 * only render for the signed-in owner — a visitor gets the profile link, which
 * is genuinely useful to them and harmless.
 */

type Source = "fedi" | "bluesky";

export interface ActorActionsProps {
  /** Canonical actor URI. The REAL stored one — never rebuilt from handle parts. */
  actorUri: string;
  /** Display handle, e.g. `@ada@mastodon.social` (or a Bluesky handle). */
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  /** Owner-only actions are hidden unless true. */
  isAdmin?: boolean;
  source?: Source;
  /** The clickable trigger — a name, a handle, an avatar. */
  children: React.ReactNode;
  className?: string;
}

/** Host of an actor URI for display, or null when it isn't a usable URL. */
function hostOf(uri: string): string | null {
  try {
    return new URL(uri).hostname;
  } catch {
    return null;
  }
}

export default function ActorActions({
  actorUri,
  handle,
  displayName,
  avatarUrl,
  isAdmin = false,
  source = "fedi",
  children,
  className,
}: ActorActionsProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ following: boolean; blocked: boolean } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Close on outside click / Escape. Without this the popup can only be
  // dismissed by its X, which is a trap on a page with several of them.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Ask what our relationship is, so we can offer Follow *or* Unfollow rather
  // than both. Only when opened, only for the owner, and only for fedi actors.
  useEffect(() => {
    if (!open || !isAdmin || source !== "fedi" || status) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/graph/status?actorUri=${encodeURIComponent(actorUri)}`);
        if (!res.ok) return;
        const d = await res.json();
        if (!cancelled) setStatus({ following: !!d.following, blocked: !!d.blocked });
      } catch {
        /* leave unknown — both actions stay available */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isAdmin, source, actorUri, status]);

  const act = async (action: string, confirmMsg?: string) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, actorUri }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        alert(d?.error || "That didn't work.");
        return;
      }
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  const domain = hostOf(actorUri);
  const profileUrl =
    source === "bluesky" ? `https://bsky.app/profile/${handle.replace(/^@/, "")}` : actorUri;
  const profileLabel = source === "bluesky" ? "Bluesky" : domain;
  const showOwnerActions = isAdmin && source === "fedi";

  return (
    <span ref={wrapRef} className={`relative inline-block ${className || ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="text-left hover:underline focus:outline-none focus-visible:underline cursor-pointer"
      >
        {children}
      </button>

      {open && (
        <span
          role="dialog"
          aria-label={`Actions for ${handle}`}
          className="absolute top-full left-0 z-50 mt-1 block w-64 rounded-xl border border-surface-600/30 bg-surface-900 p-4 text-left shadow-2xl shadow-black/50"
        >
          <span className="mb-3 flex items-center gap-3">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- remote avatars from arbitrary instances aren't in the Image allowlist
              <img src={avatarUrl} alt="" className="h-12 w-12 rounded-full" />
            ) : (
              <span className="block h-12 w-12 rounded-full bg-surface-700" />
            )}
            <span className="block min-w-0">
              <span className="block truncate text-sm font-semibold text-content">
                {displayName || handle}
              </span>
              <span className="block truncate text-xs text-content-faint">{handle}</span>
            </span>
          </span>

          <span className="flex flex-col gap-2">
            {profileUrl && (
              <a
                href={profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-accent-400 transition-colors hover:text-accent-300"
              >
                View profile{profileLabel ? ` on ${profileLabel}` : ""}
              </a>
            )}

            {showOwnerActions && (
              <>
                {status?.blocked ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act("unblock")}
                    className="text-left text-xs text-content-subtle transition-colors hover:text-moss-400 disabled:opacity-50"
                  >
                    Unblock
                  </button>
                ) : (
                  <>
                    {status?.following !== true && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act("follow")}
                        className="text-left text-xs text-content-subtle transition-colors hover:text-accent-400 disabled:opacity-50"
                      >
                        Follow
                      </button>
                    )}
                    {status?.following !== false && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => act("unfollow_by_uri")}
                        className="text-left text-xs text-content-subtle transition-colors hover:text-yellow-400 disabled:opacity-50"
                      >
                        Unfollow
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        act(
                          "block",
                          `Block ${handle}? This unfollows them, removes their posts from your feed, and refuses anything they send from now on.`,
                        )
                      }
                      className="text-left text-xs text-content-subtle transition-colors hover:text-red-400 disabled:opacity-50"
                    >
                      Block
                    </button>
                  </>
                )}
              </>
            )}
          </span>

          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="absolute right-2 top-2 text-content-dim transition-colors hover:text-content"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      )}
    </span>
  );
}
