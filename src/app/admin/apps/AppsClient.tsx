"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type TokenRow = {
  id: string;
  label: string;
  scope: string;
  clientId: string | null;
  createdVia: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

// Timezone-stable, pure formatting ("2026-06-20 05:13 UTC"). Same approach as the
// sessions screen — avoids hydration mismatch from Date/toLocaleString.
function fmtUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function sourceLabel(t: TokenRow): string {
  if (t.createdVia === "oauth") {
    return t.clientId ? `OAuth · ${t.clientId}` : "OAuth app";
  }
  return "Micropub token";
}

export default function AppsClient({ tokens }: { tokens: TokenRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function post(body: Record<string, unknown>): Promise<Response> {
    return fetch("/api/admin/apps", {
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
      router.refresh();
    } catch {
      setError("Couldn't revoke that app. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeAll() {
    setError(null);
    setBusy("all");
    try {
      const res = await post({ action: "revoke-all" });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setError("Couldn't revoke the tokens. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (tokens.length === 0) {
    return (
      <p className="text-gray-500 text-sm">
        No connected apps yet. Sign in from a FediHome app to see it here.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-red-400 text-sm">{error}</p>}

      <ul className="space-y-3">
        {tokens.map((t) => (
          <li key={t.id} className="glass-card p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-white font-medium truncate">{t.label}</p>
              <p className="text-xs text-gray-500 mt-1">
                {sourceLabel(t)} ·{" "}
                {t.lastUsedAt ? `last used ${fmtUtc(t.lastUsedAt)}` : "never used"} · added{" "}
                {fmtUtc(t.createdAt)}
                {t.expiresAt ? ` · expires ${fmtUtc(t.expiresAt)}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {t.scope.split(/\s+/).filter(Boolean).map((s) => (
                  <span
                    key={s}
                    className="text-[10px] uppercase tracking-wide bg-surface-800 text-gray-400 px-1.5 py-0.5 rounded"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
            <button
              onClick={() => revoke(t.id)}
              disabled={busy !== null}
              className="text-xs text-red-400 hover:text-red-300 whitespace-nowrap disabled:opacity-50"
            >
              {busy === t.id ? "Revoking…" : "Revoke"}
            </button>
          </li>
        ))}
      </ul>

      {tokens.length > 1 && (
        <button
          onClick={revokeAll}
          disabled={busy !== null}
          className="btn-outlined text-sm disabled:opacity-50"
        >
          {busy === "all" ? "Revoking…" : `Revoke all (${tokens.length})`}
        </button>
      )}
    </div>
  );
}
