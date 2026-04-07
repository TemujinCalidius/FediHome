"use client";

import { useState } from "react";

interface ReplyToCommentProps {
  postApId: string;
  actorUri: string;
  username: string;
  domain: string;
}

export default function ReplyToComment({
  postApId,
  actorUri,
  username,
  domain,
}: ReplyToCommentProps) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    if (!content.trim() || sending) return;
    setSending(true);
    try {
      await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reply",
          content: content.trim(),
          inReplyTo: postApId,
          targetInbox: `https://${domain}/users/${username}/inbox`,
          actorUri,
          mentionHandle: `@${username}@${domain}`,
        }),
      });
      setSent(true);
      setContent("");
      setTimeout(() => {
        setOpen(false);
        setSent(false);
      }, 2000);
    } catch {
      // silently fail
    }
    setSending(false);
  };

  if (sent) {
    return <span className="text-xs text-green-400">Reply sent!</span>;
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-accent-400 hover:text-accent-300 transition-colors"
      >
        Reply
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={`Reply to @${username}@${domain}...`}
        rows={2}
        className="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent-400/50 resize-none"
        autoFocus
      />
      <div className="flex items-center gap-2">
        <button
          onClick={handleSend}
          disabled={!content.trim() || sending}
          className="btn-primary text-xs !py-1.5 !px-4 disabled:opacity-50"
        >
          {sending ? "Sending..." : "Send"}
        </button>
        <button
          onClick={() => { setOpen(false); setContent(""); }}
          className="text-xs text-gray-500 hover:text-gray-400"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
