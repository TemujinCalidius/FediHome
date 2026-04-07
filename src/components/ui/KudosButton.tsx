"use client";

import { useState } from "react";

export default function KudosButton({ path, initialCount }: { path: string; initialCount: number }) {
  const [count, setCount] = useState(initialCount);
  const [sent, setSent] = useState(false);
  const [animating, setAnimating] = useState(false);

  const handleClick = async () => {
    if (sent) return;
    setAnimating(true);
    setTimeout(() => setAnimating(false), 600);

    try {
      const res = await fetch("/api/kudos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (res.ok) {
        setCount((c) => c + 1);
        setSent(true);
      } else if (res.status === 429) {
        setSent(true); // already sent
      }
    } catch {
      // silently fail
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-all ${
        sent
          ? "bg-accent-400/20 text-accent-400 cursor-default"
          : "bg-surface-800 text-gray-400 hover:bg-surface-700 hover:text-accent-400"
      } ${animating ? "scale-110" : "scale-100"}`}
      title={sent ? "Thanks for the kudos!" : "Send kudos"}
    >
      <span className={`transition-transform ${animating ? "scale-125" : ""}`}>
        👏
      </span>
      {count > 0 && <span>{count}</span>}
      {!sent && count === 0 && <span>Kudos</span>}
    </button>
  );
}
