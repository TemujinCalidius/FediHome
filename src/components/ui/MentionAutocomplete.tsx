"use client";

import { useState, useEffect, useRef, useCallback, type RefObject } from "react";

interface MentionResult {
  kind: "fedi" | "bluesky";
  key: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  actorUri?: string;
  did?: string;
}

/**
 * Hook that wires a textarea/input with @mention autocomplete from
 * FediFollower + FediFollowing + BlueskyFollower + BlueskyFollowing.
 *
 * Renders a floating dropdown anchored below the input when the user types "@x".
 * Inserts "@user@domain " (fedi) or "@handle.bsky.social " (bluesky) on select.
 */
export function useMentionAutocomplete(
  inputRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  value: string,
  onChange: (newValue: string) => void,
) {
  const [results, setResults] = useState<MentionResult[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const queryRangeRef = useRef<{ start: number; end: number } | null>(null);
  const lastQueryRef = useRef<string>("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Find current @mention being typed at the caret
  const detectQuery = useCallback(() => {
    const el = inputRef.current;
    if (!el) return null;
    const caret = el.selectionStart ?? 0;
    const text = el.value;
    // Look backwards from caret for an "@" that starts a word
    let i = caret - 1;
    while (i >= 0 && /[a-zA-Z0-9._@-]/.test(text[i])) i--;
    const atIdx = i + 1;
    if (text[atIdx] !== "@") return null;
    // Verify the @ is at start of a word (preceded by whitespace or start)
    if (atIdx > 0 && /[a-zA-Z0-9@]/.test(text[atIdx - 1])) return null;
    // Collect the partial after @
    const partial = text.slice(atIdx + 1, caret);
    // The partial may contain a second @ for fedi handles — that's OK, we search the full text
    return { start: atIdx, end: caret, query: partial };
  }, [inputRef]);

  // Search when query changes
  useEffect(() => {
    const detected = detectQuery();
    if (!detected || detected.query.length < 1) {
      setOpen(false);
      setResults([]);
      queryRangeRef.current = null;
      return;
    }
    queryRangeRef.current = { start: detected.start, end: detected.end };

    // Debounce 150ms
    lastQueryRef.current = detected.query;
    const q = detected.query;
    const handle = setTimeout(async () => {
      if (lastQueryRef.current !== q) return;
      try {
        const res = await fetch(`/api/mentions/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (lastQueryRef.current !== q) return;
        setResults(data.results || []);
        setActive(0);
        setOpen((data.results || []).length > 0);
      } catch {
        // silently fail
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [value, detectQuery]);

  // Position the dropdown below the caret (approximate — fall back to input bottom)
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // The dropdown is position:fixed (viewport-relative), so do NOT add scroll
    // offsets. Clamp left so the 288px (w-72) panel never spills past the right
    // edge — a fixed element that overflows escapes the page's overflow-x clip
    // and causes horizontal drift on mobile.
    const DROPDOWN_W = 288;
    const margin = 8;
    const maxLeft = Math.max(margin, (window.innerWidth || 360) - DROPDOWN_W - margin);
    setAnchor({ top: rect.bottom + 4, left: Math.min(Math.max(margin, rect.left), maxLeft) });
  }, [open, inputRef]);

  const insertResult = useCallback(
    (result: MentionResult) => {
      const range = queryRangeRef.current;
      const el = inputRef.current;
      if (!range || !el) return;
      const before = value.slice(0, range.start);
      const after = value.slice(range.end);
      const insertion = `${result.handle} `;
      const newValue = before + insertion + after;
      onChange(newValue);
      setOpen(false);
      setResults([]);
      // Restore caret after the insertion
      setTimeout(() => {
        if (!el) return;
        const newCaret = (before + insertion).length;
        el.focus();
        el.setSelectionRange(newCaret, newCaret);
      }, 0);
    },
    [value, onChange, inputRef],
  );

  // Keyboard nav
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !open) return;

    const handler = (e: Event) => {
      if (!open) return;
      const ke = e as KeyboardEvent;
      if (ke.key === "ArrowDown") {
        ke.preventDefault();
        setActive((a) => Math.min(a + 1, results.length - 1));
      } else if (ke.key === "ArrowUp") {
        ke.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (ke.key === "Enter" || ke.key === "Tab") {
        if (results[active]) {
          ke.preventDefault();
          insertResult(results[active]);
        }
      } else if (ke.key === "Escape") {
        setOpen(false);
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [open, results, active, insertResult, inputRef]);

  // Click-outside closes
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const dropdownNode =
    open && anchor && results.length > 0 ? (
      <div
        ref={containerRef}
        className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] max-h-72 overflow-y-auto bg-surface-900 border border-surface-600 rounded-lg shadow-xl"
        style={{ top: anchor.top, left: anchor.left }}
        role="listbox"
      >
        {results.map((r, i) => (
          <button
            key={`${r.kind}:${r.key}`}
            type="button"
            onClick={() => insertResult(r)}
            onMouseEnter={() => setActive(i)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
              i === active ? "bg-accent-400/15" : "hover:bg-surface-800"
            }`}
          >
            {r.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.avatarUrl} alt="" className="w-6 h-6 rounded-full flex-shrink-0" />
            ) : (
              <div className="w-6 h-6 rounded-full bg-surface-700 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-white font-semibold truncate">
                  {r.displayName || r.handle.replace(/^@/, "")}
                </span>
                <span
                  className={`text-[9px] font-bold uppercase tracking-wider px-1 rounded ${
                    r.kind === "fedi"
                      ? "bg-accent-400/20 text-accent-300"
                      : "bg-blue-400/20 text-blue-300"
                  }`}
                >
                  {r.kind}
                </span>
              </div>
              <div className="text-gray-500 text-xs truncate">{r.handle}</div>
            </div>
          </button>
        ))}
      </div>
    ) : null;

  return { dropdownNode };
}
