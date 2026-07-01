"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useMentionAutocomplete } from "@/components/ui/MentionAutocomplete";

interface ReplyToCommentProps {
  postApId: string;
  actorUri: string;
  username: string;
  domain: string;
}

// Match a Bluesky-style handle (single @ + dotted handle).
// We strip fedi-style @user@domain matches first so we don't mistake them.
const FEDI_MENTION_RE = /@[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]+/g;
const BSKY_MENTION_RE = /@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/g;

function containsBlueskyMention(text: string): boolean {
  const stripped = text.replace(FEDI_MENTION_RE, "");
  return BSKY_MENTION_RE.test(stripped);
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
  const [crosspostBluesky, setCrosspostBluesky] = useState(false);
  const [userTouchedToggle, setUserTouchedToggle] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { dropdownNode: mentionDropdown } = useMentionAutocomplete(
    textareaRef,
    content,
    setContent,
  );

  const autoSuggestBluesky = useMemo(() => containsBlueskyMention(content), [content]);

  // Auto-flip the toggle on when a Bluesky mention is detected, unless the user already touched it
  useEffect(() => {
    if (autoSuggestBluesky && !userTouchedToggle) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-enable the crosspost toggle once when a mention is detected, unless the user already set it
      setCrosspostBluesky(true);
    }
  }, [autoSuggestBluesky, userTouchedToggle]);

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
          crosspostBluesky,
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
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={`Reply to @${username}@${domain}...`}
        rows={2}
        className="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent-400/50 resize-none"
        autoFocus
      />
      {mentionDropdown}
      <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={crosspostBluesky}
          onChange={(e) => {
            setUserTouchedToggle(true);
            setCrosspostBluesky(e.target.checked);
          }}
          className="rounded border-surface-600 bg-surface-800 text-accent-400 focus:ring-accent-400/30"
        />
        Also post to Bluesky
        {autoSuggestBluesky && (
          <span className="text-blue-400 text-[10px]">
            Bluesky mention detected — auto-enabled
          </span>
        )}
      </label>
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
