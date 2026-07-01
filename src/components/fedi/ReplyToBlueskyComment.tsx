"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import { useMentionAutocomplete } from "@/components/ui/MentionAutocomplete";

const FEDI_MENTION_RE = /@[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]+/g;

function containsFediMention(text: string): boolean {
  return FEDI_MENTION_RE.test(text);
}

export default function ReplyToBlueskyComment({ blueskyUri, authorHandle }: { blueskyUri: string; authorHandle: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [crosspostFedi, setCrosspostFedi] = useState(false);
  const [userTouchedToggle, setUserTouchedToggle] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { dropdownNode: mentionDropdown } = useMentionAutocomplete(
    textareaRef,
    content,
    setContent,
  );

  const autoSuggestFedi = useMemo(() => containsFediMention(content), [content]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-enable the crosspost toggle once when a mention is detected, unless the user already set it
    if (autoSuggestFedi && !userTouchedToggle) setCrosspostFedi(true);
  }, [autoSuggestFedi, userTouchedToggle]);

  const handleSend = async () => {
    if (!content.trim() || sending) return;
    setSending(true);
    try {
      await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "bsky_reply",
          content: content.trim(),
          blueskyUri,
          crosspostFedi,
        }),
      });
      setSent(true);
      setContent("");
      setTimeout(() => { setOpen(false); setSent(false); }, 2000);
    } catch {}
    setSending(false);
  };

  if (sent) return <span className="text-xs text-green-400">Reply sent!</span>;
  if (!open) return <button onClick={() => setOpen(true)} className="text-xs text-accent-400 hover:text-accent-300 transition-colors">Reply</button>;

  return (
    <div className="mt-2 space-y-2">
      <textarea ref={textareaRef} value={content} onChange={(e) => setContent(e.target.value)} placeholder={`Reply to @${authorHandle}...`} rows={2} className="w-full bg-surface-800 border border-surface-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent-400/50 resize-none" autoFocus />
      {mentionDropdown}
      <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={crosspostFedi}
          onChange={(e) => { setUserTouchedToggle(true); setCrosspostFedi(e.target.checked); }}
          className="rounded border-surface-600 bg-surface-800 text-accent-400 focus:ring-accent-400/30"
        />
        Also post to Fediverse
        {autoSuggestFedi && (
          <span className="text-accent-400 text-[10px]">
            Fedi mention detected — auto-enabled
          </span>
        )}
      </label>
      <div className="flex items-center gap-2">
        <button onClick={handleSend} disabled={!content.trim() || sending} className="btn-primary text-xs !py-1.5 !px-4 disabled:opacity-50">{sending ? "Sending..." : "Send"}</button>
        <button onClick={() => { setOpen(false); setContent(""); }} className="text-xs text-gray-500 hover:text-gray-400">Cancel</button>
      </div>
    </div>
  );
}
