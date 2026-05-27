"use client";

import { useState, useRef } from "react";
import { useMentionAutocomplete } from "@/components/ui/MentionAutocomplete";

interface EditReplyFormProps {
  replyId: string;
  initialContent: string;
}

export default function EditReplyForm({ replyId, initialContent }: EditReplyFormProps) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { dropdownNode: mentionDropdown } = useMentionAutocomplete(
    textareaRef,
    content,
    setContent,
  );

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs text-gray-500 hover:text-accent-400 transition-colors"
      >
        Edit
      </button>
    );
  }

  const save = async () => {
    if (!content.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit_reply", replyId, content: content.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        // Page refresh shows the updated content + federation status
        window.location.reload();
      } else {
        setError(data.error || "Failed to save");
        setSaving(false);
      }
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  return (
    <div className="w-full mt-2 space-y-2">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        className="w-full bg-surface-800 border border-surface-700 rounded p-2 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none resize-none"
        autoFocus
      />
      {mentionDropdown}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={save}
          disabled={saving || !content.trim()}
          className="btn-primary text-xs disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setContent(initialContent);
            setError(null);
          }}
          className="text-gray-500 hover:text-white"
        >
          Cancel
        </button>
        <span className="text-gray-600 ml-auto">
          Federates AP Update — Mastodon shows &ldquo;edited X ago&rdquo;
        </span>
      </div>
    </div>
  );
}
