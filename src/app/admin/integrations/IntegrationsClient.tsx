"use client";

import { useState } from "react";
import Link from "next/link";
import type { IntegrationStatus } from "@/lib/integrations";

/**
 * Admin crosspost integrations (#59): connect Bluesky + Threads in-app. Secrets
 * are write-only here — the stored app password / token is never sent back, so a
 * configured field starts empty; type a new value to set or replace it. Saves go
 * to /api/admin/integrations, which encrypts them at rest and verifies the
 * connection before storing.
 */

type Provider = "bluesky" | "threads" | "dayone";

export default function IntegrationsClient({
  initialStatus,
  encryptionAvailable,
}: {
  initialStatus: IntegrationStatus;
  encryptionAvailable: boolean;
}) {
  const [status, setStatus] = useState<IntegrationStatus>(initialStatus);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [bskyHandle, setBskyHandle] = useState(initialStatus.bluesky.handle ?? "");
  const [bskyPassword, setBskyPassword] = useState("");
  const [threadsUserId, setThreadsUserId] = useState(initialStatus.threads.userId ?? "");
  const [threadsToken, setThreadsToken] = useState("");
  // Journal by email (#326) — the last credential that needed file access.
  const [dayOneEmail, setDayOneEmail] = useState(initialStatus.dayOne.dayOneEmail ?? "");
  const [smtpHost, setSmtpHost] = useState(initialStatus.dayOne.host ?? "");
  const [smtpPort, setSmtpPort] = useState(String(initialStatus.dayOne.port ?? 587));
  const [smtpUser, setSmtpUser] = useState(initialStatus.dayOne.user ?? "");
  const [smtpPass, setSmtpPass] = useState("");

  async function call(payload: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const res = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  }

  const payloadFor = (provider: Provider, action: string) => {
    if (provider === "bluesky") return { action, provider, handle: bskyHandle, password: bskyPassword };
    if (provider === "dayone") {
      return { action, provider, dayOneEmail, host: smtpHost, port: Number(smtpPort), user: smtpUser, pass: smtpPass };
    }
    return { action, provider, userId: threadsUserId, accessToken: threadsToken };
  };

  const label = (p: Provider) => (p === "bluesky" ? "Bluesky" : p === "dayone" ? "Journal email" : "Threads");

  async function run(provider: Provider, action: "save" | "test" | "disconnect") {
    setBusy(`${provider}:${action}`);
    setResult(null);
    try {
      const { ok, data } = await call(action === "disconnect" ? { action, provider } : payloadFor(provider, action));
      if (action === "test") {
        setResult(ok && (data as { ok?: boolean }).ok
          ? { ok: true, msg: `${label(provider)}: connection OK ✓` }
          : { ok: false, msg: `${label(provider)} test failed — ${(data as { error?: string }).error || "check the credentials"}` });
        return;
      }
      if (!ok) {
        setResult({ ok: false, msg: (data as { error?: string }).error || "Something went wrong" });
        return;
      }
      setStatus(data.status as IntegrationStatus);
      if (provider === "bluesky") setBskyPassword("");
      else if (provider === "dayone") setSmtpPass("");
      else setThreadsToken("");
      if (action === "disconnect") {
        const st = data.status as IntegrationStatus;
        if (provider === "bluesky") setBskyHandle(st.bluesky.handle ?? "");
        else if (provider === "dayone") {
          setDayOneEmail(st.dayOne.dayOneEmail ?? "");
          setSmtpHost(st.dayOne.host ?? "");
          setSmtpPort(String(st.dayOne.port ?? 587));
          setSmtpUser(st.dayOne.user ?? "");
        } else setThreadsUserId(st.threads.userId ?? "");
      }
      setResult({ ok: true, msg: action === "disconnect" ? `${label(provider)} disconnected.` : `${label(provider)} connected.` });
    } catch {
      setResult({ ok: false, msg: "Request failed" });
    } finally {
      setBusy(null);
    }
  }

  const field = (lbl: string, value: string, onChange: (v: string) => void, opts: { type?: string; placeholder?: string } = {}) => (
    <label className="flex flex-col gap-1 text-xs text-gray-400">
      <span>{lbl}</span>
      <input
        type={opts.type ?? "text"}
        value={value}
        placeholder={opts.placeholder ?? ""}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 text-sm text-white"
      />
    </label>
  );

  const statusLine = (configured: boolean, source: "db" | "env" | null, who: string | null) => {
    if (!configured) return <span className="text-gray-500">Not connected.</span>;
    if (source === "env")
      return <span className="text-gray-400">Configured via environment variable{who ? ` (${who})` : ""}. Save below to manage it in-app instead.</span>;
    return <span className="text-moss-400">Connected{who ? ` — ${who}` : ""}.</span>;
  };

  return (
    <main className="max-w-2xl mx-auto px-4 py-10">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Integrations</h1>
        <Link href="/timeline" className="text-xs text-gray-400 hover:text-white underline">← Timeline</Link>
      </div>

      {!encryptionAvailable && (
        <p className="mb-4 text-sm text-red-400">
          Encryption is unavailable because <code>ADMIN_SECRET</code> isn&apos;t set — credentials can&apos;t be saved securely until it is.
        </p>
      )}

      <div className="rounded-lg border border-surface-700 bg-surface-900 px-5">
        <p className="text-xs text-gray-500 pt-4 m-0">
          Connect your crossposting accounts. Credentials are encrypted at rest and never shown again — no server or file access needed.
        </p>

        {/* ── Bluesky ── */}
        <section className="py-4 border-b border-surface-800">
          <h2 className="text-sm font-semibold text-white mb-1">Bluesky</h2>
          <p className="text-xs mb-3">{statusLine(status.bluesky.configured, status.bluesky.source, status.bluesky.handle && `@${status.bluesky.handle}`)}</p>
          <div className="flex flex-col gap-3">
            {field("Handle", bskyHandle, setBskyHandle, { placeholder: "yourhandle.bsky.social" })}
            {field("App password", bskyPassword, setBskyPassword, {
              type: "password",
              placeholder: status.bluesky.configured ? "•••• saved — type to replace" : "xxxx-xxxx-xxxx-xxxx",
            })}
            <p className="text-xs text-gray-600 m-0">
              Create an app password at{" "}
              <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener noreferrer" className="text-accent-400 hover:text-accent-300">bsky.app → App Passwords</a>{" "}
              (not your main password).
            </p>
            <div className="flex items-center gap-3 pt-1">
              <button onClick={() => run("bluesky", "save")} disabled={!!busy || !encryptionAvailable} className="btn-primary text-xs disabled:opacity-50">
                {busy === "bluesky:save" ? "Saving…" : "Save"}
              </button>
              <button onClick={() => run("bluesky", "test")} disabled={!!busy} className="btn-outlined text-xs disabled:opacity-50">
                {busy === "bluesky:test" ? "Testing…" : "Test"}
              </button>
              {status.bluesky.source === "db" && (
                <button onClick={() => run("bluesky", "disconnect")} disabled={!!busy}
                  className="text-xs text-gray-400 hover:text-red-400 underline disabled:opacity-40">Disconnect</button>
              )}
            </div>
          </div>
        </section>

        {/* ── Threads ── */}
        <section className="py-4 border-b border-surface-800 last:border-b-0">
          <h2 className="text-sm font-semibold text-white mb-1">Threads</h2>
          <p className="text-xs mb-3">{statusLine(status.threads.configured, status.threads.source, status.threads.userId && `user ${status.threads.userId}`)}</p>
          <div className="flex flex-col gap-3">
            {field("User ID", threadsUserId, setThreadsUserId, { placeholder: "17841400000000000" })}
            {field("Access token", threadsToken, setThreadsToken, {
              type: "password",
              placeholder: status.threads.configured ? "•••• saved — type to replace" : "THQ...",
            })}
            <p className="text-xs text-gray-600 m-0">A long-lived Threads Graph API access token and your numeric user ID.</p>
            <div className="flex items-center gap-3 pt-1">
              <button onClick={() => run("threads", "save")} disabled={!!busy || !encryptionAvailable} className="btn-primary text-xs disabled:opacity-50">
                {busy === "threads:save" ? "Saving…" : "Save"}
              </button>
              <button onClick={() => run("threads", "test")} disabled={!!busy} className="btn-outlined text-xs disabled:opacity-50">
                {busy === "threads:test" ? "Testing…" : "Test"}
              </button>
              {status.threads.source === "db" && (
                <button onClick={() => run("threads", "disconnect")} disabled={!!busy}
                  className="text-xs text-gray-400 hover:text-red-400 underline disabled:opacity-40">Disconnect</button>
              )}
            </div>
          </div>
        </section>

        {/* ── Journal by email (DayOne) ── */}
        <section className="py-4 border-b border-surface-800 last:border-b-0">
          <h2 className="text-sm font-semibold text-white mb-1">Journal by email</h2>
          <p className="text-xs mb-3">
            {statusLine(status.dayOne.configured, status.dayOne.source, status.dayOne.dayOneEmail)}
          </p>
          <div className="flex flex-col gap-3">
            {field("Journal address", dayOneEmail, setDayOneEmail, { placeholder: "yourjournal@dayone.me" })}
            {field("SMTP host", smtpHost, setSmtpHost, { placeholder: "smtp.example.com" })}
            {field("SMTP port", smtpPort, setSmtpPort, { placeholder: "587" })}
            {field("SMTP username", smtpUser, setSmtpUser, { placeholder: "you@example.com" })}
            {field("SMTP password", smtpPass, setSmtpPass, {
              type: "password",
              placeholder: status.dayOne.configured ? "•••• saved — type to replace" : "",
            })}
            <p className="text-xs text-gray-600 m-0">
              Posts are emailed to your journal&apos;s import address when you publish. There&apos;s no Test
              button here on purpose — the only way to check an SMTP credential is to send a message,
              which would leave a stray entry in your journal every time you saved.
            </p>
            <div className="flex items-center gap-3 pt-1">
              <button onClick={() => run("dayone", "save")} disabled={!!busy || !encryptionAvailable} className="btn-primary text-xs disabled:opacity-50">
                {busy === "dayone:save" ? "Saving…" : "Save"}
              </button>
              {status.dayOne.source === "db" && (
                <button onClick={() => run("dayone", "disconnect")} disabled={!!busy}
                  className="text-xs text-gray-400 hover:text-red-400 underline disabled:opacity-40">Disconnect</button>
              )}
            </div>
          </div>
        </section>
      </div>

      {result && <p className={`mt-4 text-sm ${result.ok ? "text-green-400" : "text-red-400"}`}>{result.msg}</p>}

      <p className="mt-6 text-xs text-gray-500">
        Crossposting to a connected account happens automatically when you publish. Followers / DMs / notifications sync from Bluesky can be
        toggled under <Link href="/admin/settings" className="text-accent-400 hover:text-accent-300">Settings</Link>.
      </p>
    </main>
  );
}
