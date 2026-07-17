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

// Kept local (not imported from @/lib/oauth, which pulls in server-only deps).
// The server re-validates with sanitizeScope, so this list is just the UI menu.
const ALL_SCOPES = ["read", "create", "update", "delete", "media", "interact", "dm", "manage"] as const;

// Timezone-stable, pure formatting ("2026-06-20 05:13 UTC").
function fmtUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function sourceLabel(t: TokenRow): string {
  if (t.createdVia === "oauth") {
    return t.clientId ? `OAuth · ${t.clientId}` : "OAuth app";
  }
  if (t.createdVia === "manual") return "Generated token";
  return "Micropub token";
}

const scopeBadges = (scope: string) => (
  <div className="mt-2 flex flex-wrap gap-1">
    {scope.split(/\s+/).filter(Boolean).map((s) => (
      <span key={s} className="text-[10px] uppercase tracking-wide bg-surface-800 text-gray-400 px-1.5 py-0.5 rounded">
        {s}
      </span>
    ))}
  </div>
);

export default function AppsClient({ tokens }: { tokens: TokenRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);

  // Generate-token form + the one-time reveal.
  const [genOpen, setGenOpen] = useState(false);
  const [genLabel, setGenLabel] = useState("");
  const [genScopes, setGenScopes] = useState<string[]>(["read"]);
  const [minted, setMinted] = useState<{ token: string; label: string; scope: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  function startEdit(t: TokenRow) {
    setError(null);
    setEditing(t.id);
    setDraft(t.scope.split(/\s+/).filter(Boolean));
  }

  function toggleScope(s: string) {
    setDraft((d) => (d.includes(s) ? d.filter((x) => x !== s) : [...d, s]));
  }

  async function saveScopes(id: string) {
    if (draft.length === 0) {
      setError("Pick at least one scope.");
      return;
    }
    setError(null);
    setBusy(id);
    try {
      const res = await post({ action: "edit_scopes", id, scope: draft.join(" ") });
      if (!res.ok) throw new Error();
      setEditing(null);
      router.refresh();
    } catch {
      setError("Couldn't update the scopes. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function toggleGenScope(s: string) {
    setGenScopes((d) => (d.includes(s) ? d.filter((x) => x !== s) : [...d, s]));
  }

  async function generate() {
    if (genScopes.length === 0) {
      setError("Pick at least one scope.");
      return;
    }
    setError(null);
    setBusy("gen");
    try {
      const res = await post({ action: "create", label: genLabel.trim(), scope: genScopes.join(" ") });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Couldn't generate a token.");
        return;
      }
      setMinted({ token: data.token, label: data.label, scope: data.scope });
      setGenOpen(false);
      setGenLabel("");
      setGenScopes(["read"]);
      setCopied(false);
      router.refresh();
    } catch {
      setError("Couldn't generate a token.");
    } finally {
      setBusy(null);
    }
  }

  async function copyToken() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch {
      /* clipboard blocked — the token is selectable in the box */
    }
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* One-time reveal of a freshly minted token */}
      {minted && (
        <div className="rounded-lg border border-accent-500/40 bg-surface-900 p-4">
          <p className="text-sm text-white font-medium">New token — “{minted.label}”</p>
          <p className="text-xs text-gray-400 mt-1">
            Copy it now — it&apos;s shown <strong>once</strong> and can&apos;t be retrieved later. If you lose it, revoke it here and generate a new one.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all bg-surface-950 border border-surface-700 rounded px-2 py-1.5 text-xs text-accent-300 font-mono">
              {minted.token}
            </code>
            <button onClick={copyToken} className="btn-outlined text-xs !py-1.5 whitespace-nowrap">
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          {scopeBadges(minted.scope)}
          <button onClick={() => setMinted(null)} className="mt-3 text-xs text-gray-400 hover:text-white">
            Done
          </button>
        </div>
      )}

      {/* Generate a scoped token out of band */}
      {!genOpen ? (
        <button
          onClick={() => { setGenOpen(true); setError(null); }}
          disabled={busy !== null}
          className="btn-primary text-xs !py-1.5 disabled:opacity-50"
        >
          + Generate app token
        </button>
      ) : (
        <div className="rounded-lg border border-surface-700 bg-surface-900 p-4">
          <p className="text-sm text-white font-medium mb-2">Generate app token</p>
          <p className="text-xs text-gray-500 mb-3">
            A scoped bearer token you can paste into a client (headless/CI, a read-only reader, or App Store review) — without sharing your admin secret.
          </p>
          <label className="flex flex-col gap-1 text-xs text-gray-400 mb-3">
            <span>Label</span>
            <input
              type="text"
              value={genLabel}
              onChange={(e) => setGenLabel(e.target.value)}
              placeholder="e.g. CI reader, App Store review"
              maxLength={100}
              className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
            />
          </label>
          <div className="flex flex-wrap gap-x-4 gap-y-2 mb-3">
            {ALL_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" checked={genScopes.includes(s)} onChange={() => toggleGenScope(s)} />
                {s}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={generate} disabled={busy !== null} className="btn-primary text-xs !py-1.5 disabled:opacity-50">
              {busy === "gen" ? "Generating…" : "Generate"}
            </button>
            <button
              onClick={() => { setGenOpen(false); setError(null); }}
              disabled={busy !== null}
              className="text-xs text-gray-400 hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {tokens.length === 0 ? (
        <p className="text-gray-500 text-sm">
          No connected apps yet. Sign in from a FediHome app, or generate a token above.
        </p>
      ) : (
        <ul className="space-y-3">
          {tokens.map((t) => (
            <li key={t.id} className="glass-card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-white font-medium truncate">{t.label}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {sourceLabel(t)} ·{" "}
                    {t.lastUsedAt ? `last used ${fmtUtc(t.lastUsedAt)}` : "never used"} · added{" "}
                    {fmtUtc(t.createdAt)}
                    {t.expiresAt ? ` · expires ${fmtUtc(t.expiresAt)}` : ""}
                  </p>
                  {editing !== t.id && scopeBadges(t.scope)}
                </div>
                <div className="flex items-center gap-3 whitespace-nowrap">
                  {editing !== t.id && (
                    <button
                      onClick={() => startEdit(t)}
                      disabled={busy !== null}
                      className="text-xs text-gray-400 hover:text-white disabled:opacity-50"
                    >
                      Edit
                    </button>
                  )}
                  <button
                    onClick={() => revoke(t.id)}
                    disabled={busy !== null}
                    className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </div>
              </div>

              {editing === t.id && (
                <div className="mt-3 border-t border-surface-700 pt-3">
                  <div className="flex flex-wrap gap-x-4 gap-y-2 mb-3">
                    {ALL_SCOPES.map((s) => (
                      <label key={s} className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                        <input type="checkbox" checked={draft.includes(s)} onChange={() => toggleScope(s)} />
                        {s}
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => saveScopes(t.id)}
                      disabled={busy !== null}
                      className="btn-primary text-xs !py-1.5 disabled:opacity-50"
                    >
                      {busy === t.id ? "Saving…" : "Save scopes"}
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      disabled={busy !== null}
                      className="text-xs text-gray-400 hover:text-white disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {tokens.length > 1 && (
        <button onClick={revokeAll} disabled={busy !== null} className="btn-outlined text-sm disabled:opacity-50">
          {busy === "all" ? "Revoking…" : `Revoke all (${tokens.length})`}
        </button>
      )}
    </div>
  );
}
