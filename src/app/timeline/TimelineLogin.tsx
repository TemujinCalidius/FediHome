"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function TimelineLogin() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  // Signed in, but still using ADMIN_SECRET as the password (#411). The API has
  // reported this since #356; nothing consumed it, so an owner could keep typing
  // a 64-character key indefinitely and never learn there was an alternative.
  const [needsPassword, setNeedsPassword] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Set the admin cookie
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.needsPassword) {
        setNeedsPassword(true);
        return;
      }
      router.refresh();
    } else {
      setError(true);
    }
  }

  // Offered, never imposed. `needsPassword` is derived from a database read that
  // returns null on failure, so a transient DB error reports it as true — this
  // has to be dismissible and must never block getting in.
  if (needsPassword) {
    return (
      <div className="max-w-sm mx-auto px-6 py-32">
        <div className="glass-card p-8">
          <h1 className="font-display text-xl font-bold text-white mb-4">You&apos;re in</h1>
          <p className="text-sm text-gray-400 mb-3">
            You signed in with <code>ADMIN_SECRET</code> — a 64-character key that was never
            meant to be typed. You can set a real password instead, and it&apos;s safe to
            change whenever you like: your saved Bluesky, Threads and notification
            credentials aren&apos;t affected.
          </p>
          <div className="flex flex-col gap-2 mt-5">
            <Link href="/admin/site#security" className="btn-primary w-full text-sm text-center">
              Set a password
            </Link>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="text-xs text-gray-500 hover:text-gray-300 underline"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-sm mx-auto px-6 py-32">
      <div className="glass-card p-8 text-center">
        <h1 className="font-display text-xl font-bold text-white mb-6">
          Timeline
        </h1>
        <p className="text-gray-500 text-sm mb-6">
          This is a private page. Enter your admin password to continue.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(false); }}
            placeholder="Admin password"
            className="w-full bg-surface-800 border border-surface-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none"
          />
          {error && <p className="text-red-400 text-xs">Incorrect password.</p>}
          <button type="submit" className="btn-primary w-full text-sm">
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}
