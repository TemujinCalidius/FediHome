"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SessionRow = {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
  userAgent: string | null;
  current: boolean;
};

/** Coarse, pure device label from a user-agent string. */
function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Macintosh|Mac OS X/.test(ua)
    ? "macOS"
    : /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Linux/.test(ua)
    ? "Linux"
    : "Unknown OS";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
    ? "Opera"
    : /Firefox\//.test(ua)
    ? "Firefox"
    : /Chrome\//.test(ua)
    ? "Chrome"
    : /Safari\//.test(ua)
    ? "Safari"
    : "Browser";
  return `${browser} on ${os}`;
}

// Timezone-stable, pure formatting ("2026-06-20 05:13 UTC"). Avoids the
// hydration mismatch + render-purity pitfalls of Date.now()/toLocaleString.
function fmtUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export default function SessionsClient({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const otherCount = sessions.filter((s) => !s.current).length;

  function post(body: Record<string, unknown>): Promise<Response> {
    return fetch("/api/admin/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function revoke(id: string) {
    setError(null);
    setBusy(id);
    try {
      const res = await post({ action: "revoke", id });
      if (!res.ok) throw new Error();
      const data = await res.json().catch(() => ({}));
      if (data.self) {
        // Revoked our own session — finish the logout and leave.
        await fetch("/api/admin/logout", { method: "POST" });
        router.push("/timeline");
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't revoke that session. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    setError(null);
    setBusy("others");
    try {
      const res = await post({ action: "revoke-others" });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setError("Couldn't revoke the other sessions. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function signOutThisDevice() {
    setError(null);
    setBusy("self");
    try {
      await fetch("/api/admin/logout", { method: "POST" });
      router.push("/timeline");
    } catch {
      setError("Couldn't sign out. Try again.");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-red-400 text-sm">{error}</p>}

      <ul className="space-y-3">
        {sessions.map((s) => (
          <li
            key={s.id}
            className="glass-card p-4 flex items-center justify-between gap-4"
          >
            <div className="min-w-0">
              <p className="text-sm text-white font-medium flex items-center gap-2">
                {deviceLabel(s.userAgent)}
                {s.current && (
                  <span className="text-[10px] uppercase tracking-wide bg-accent-400/15 text-accent-400 px-1.5 py-0.5 rounded">
                    This device
                  </span>
                )}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Last active {fmtUtc(s.lastUsedAt)} · signed in {fmtUtc(s.createdAt)}
                {s.expiresAt ? ` · expires ${fmtUtc(s.expiresAt)}` : ""}
              </p>
            </div>
            {s.current ? (
              <button
                onClick={signOutThisDevice}
                disabled={busy !== null}
                className="text-xs text-gray-400 hover:text-white whitespace-nowrap disabled:opacity-50"
              >
                {busy === "self" ? "Signing out…" : "Sign out"}
              </button>
            ) : (
              <button
                onClick={() => revoke(s.id)}
                disabled={busy !== null}
                className="text-xs text-red-400 hover:text-red-300 whitespace-nowrap disabled:opacity-50"
              >
                {busy === s.id ? "Revoking…" : "Revoke"}
              </button>
            )}
          </li>
        ))}
      </ul>

      {otherCount > 0 && (
        <button
          onClick={revokeOthers}
          disabled={busy !== null}
          className="btn-outlined text-sm disabled:opacity-50"
        >
          {busy === "others"
            ? "Signing out…"
            : `Sign out all other sessions (${otherCount})`}
        </button>
      )}
    </div>
  );
}
