"use client";

import { useState, useRef } from "react";

type Result = {
  type: "post" | "photo";
  slug: string;
  title: string;
  snippet: string;
  category: string;
  url: string;
  publishedAt: string;
};

export default function SearchClient() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  // Debounced search driven from the input handler (not an effect) — keeps all
  // state updates in event/async callbacks.
  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setQ(value);
    if (timer.current) clearTimeout(timer.current);

    const query = value.trim();
    if (query.length < 2) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    const mySeq = ++seq.current;
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (seq.current === mySeq) {
          setResults(Array.isArray(data.results) ? data.results : []);
          setSearched(true);
        }
      } catch {
        if (seq.current === mySeq) setResults([]);
      } finally {
        if (seq.current === mySeq) setLoading(false);
      }
    }, 250);
  }

  return (
    <div className="space-y-4">
      <input
        type="search"
        value={q}
        onChange={onChange}
        autoFocus
        placeholder="Search posts and photos…"
        className="w-full bg-surface-800 border border-surface-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none"
      />

      {loading && <p className="text-gray-500 text-sm">Searching…</p>}
      {!loading && searched && results.length === 0 && (
        <p className="text-gray-500 text-sm">No matches.</p>
      )}

      <ul className="space-y-3">
        {results.map((r) => (
          <li key={`${r.type}:${r.slug}`}>
            <a
              href={r.url}
              className="glass-card p-4 block hover:border-accent-400/20 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wide bg-surface-800 text-gray-400 px-1.5 py-0.5 rounded">
                  {r.type}
                </span>
                <span className="text-sm text-white font-medium truncate">{r.title}</span>
              </div>
              {r.snippet && <p className="text-xs text-gray-500 line-clamp-2">{r.snippet}</p>}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
