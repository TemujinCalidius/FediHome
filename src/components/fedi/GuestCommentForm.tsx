"use client";

import { useState } from "react";

export default function GuestCommentForm({
  postId,
  photoId,
}: {
  postId?: string;
  photoId?: string;
}) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: name.trim(),
          content: content.trim(),
          postId,
          photoId,
          // Honeypot field — should be empty
          website: (document.getElementById("website-hp") as HTMLInputElement)?.value,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to submit comment.");
        return;
      }

      setSubmitted(true);
    } catch {
      setError("Failed to submit comment. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="glass-card p-5 text-center">
        <p className="text-accent-400 font-semibold mb-1">Comment submitted!</p>
        <p className="text-gray-500 text-sm">
          Your comment is pending moderation and will appear once approved.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="glass-card p-5">
      <h3 className="text-sm font-semibold text-white mb-4">Leave a Comment</h3>
      <p className="text-xs text-gray-600 mb-4">
        No account needed. Comments are moderated before appearing.
      </p>

      <div className="space-y-3">
        <input
          type="text"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          className="w-full bg-surface-800 border border-surface-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none"
        />

        {/* Honeypot — hidden from real users, bots fill it */}
        <input
          type="text"
          id="website-hp"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          className="absolute opacity-0 h-0 w-0 overflow-hidden"
        />

        <textarea
          placeholder="Your comment..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
          maxLength={2000}
          rows={3}
          className="w-full bg-surface-800 border border-surface-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none resize-none"
        />

        {error && (
          <p className="text-red-400 text-xs">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="btn-primary text-xs disabled:opacity-50"
        >
          {submitting ? "Submitting..." : "Submit Comment"}
        </button>
      </div>
    </form>
  );
}
