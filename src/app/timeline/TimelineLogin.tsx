"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function TimelineLogin() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
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
      router.refresh();
    } else {
      setError(true);
    }
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
