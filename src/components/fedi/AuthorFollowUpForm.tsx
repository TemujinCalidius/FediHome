"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AuthorFollowUpForm({ postId }: { postId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = 300 - content.length;
  const overLimit = remaining < 0;

  const handleSend = async () => {
    if (!content.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: content.trim(),
          inReplyToPostId: postId,
          crosspostBluesky: true,
          crosspostThreads: false,
          crosspostDayOne: false,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setContent("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post follow-up");
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn-outlined text-xs"
      >
        Add follow-up
      </button>
    );
  }

  return (
    <div className="space-y-2 glass-card p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wider">
        Add a follow-up — threads under this post on Bluesky &amp; the Fediverse
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Add more context to this post..."
        rows={3}
        className="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent-400/50 resize-none"
        autoFocus
      />
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs font-mono ${overLimit ? "text-red-400" : "text-gray-500"}`}>
          {remaining} chars (Bluesky truncates beyond 300)
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setOpen(false); setContent(""); setError(null); }}
            className="text-xs text-gray-500 hover:text-gray-400"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={!content.trim() || sending}
            className="btn-primary text-xs !py-1.5 !px-4 disabled:opacity-50"
          >
            {sending ? "Posting..." : "Post follow-up"}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
