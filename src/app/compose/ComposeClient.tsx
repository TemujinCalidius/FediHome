"use client";

import { useState, useRef, useCallback } from "react";

interface PhotoAttachment {
  url: string;
  alt: string;
  file?: File;
  preview: string;
}

export default function ComposeClient() {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [description, setDescription] = useState("");
  const [photos, setPhotos] = useState<PhotoAttachment[]>([]);
  const [crosspostBluesky, setCrosspostBluesky] = useState(true);
  const [crosspostThreads, setCrosspostThreads] = useState(true);
  const [crosspostDayOne, setCrosspostDayOne] = useState(true);
  const [addToPhotography, setAddToPhotography] = useState(false);
  const [photoCategory, setPhotoCategory] = useState("general");
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; url?: string; error?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isArticle = title.trim().length > 0;
  const charCount = content.length;

  // Auto-grow textarea
  const handleContentChange = (value: string) => {
    setContent(value);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  };

  // Upload photo to /api/media
  const uploadPhoto = useCallback(async (file: File): Promise<string | null> => {
    const form = new FormData();
    form.append("file", file);

    // Use Micropub token from cookie — the media endpoint needs a Bearer token
    // We'll call our own proxy instead
    try {
      const res = await fetch("/api/media", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${document.cookie.match(/sl_admin=([^;]+)/)?.[1] || ""}`,
        },
        body: form,
      });

      if (!res.ok) return null;
      const data = await res.json();
      return data.url;
    } catch {
      return null;
    }
  }, []);

  const handleFileSelect = async (files: FileList | null) => {
    if (!files) return;
    const remaining = 4 - photos.length;
    const toUpload = Array.from(files).slice(0, remaining);

    setUploading(true);
    for (const file of toUpload) {
      if (!file.type.startsWith("image/")) continue;

      const preview = URL.createObjectURL(file);
      const url = await uploadPhoto(file);

      if (url) {
        setPhotos((prev) => [...prev, { url, alt: "", preview }]);
      }
    }
    setUploading(false);
  };

  const removePhoto = (index: number) => {
    setPhotos((prev) => {
      const removed = prev[index];
      if (removed.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFileSelect(e.dataTransfer.files);
  };

  const handleSubmit = async () => {
    if (!content.trim() || posting) return;
    setPosting(true);
    setResult(null);

    try {
      const res = await fetch("/api/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          content: content.trim(),
          description: description.trim() || undefined,
          photos: photos.map((p) => ({ url: p.url, alt: p.alt })),
          crosspostBluesky,
          crosspostThreads,
          crosspostDayOne,
          addToPhotography: photos.length > 0 && addToPhotography,
          photoCategory: addToPhotography ? photoCategory : undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setResult({ success: true, url: data.post.url });
        // Reset form
        setTitle("");
        setContent("");
        setDescription("");
        setPhotos([]);
      } else {
        setResult({ success: false, error: data.error || "Failed to post" });
      }
    } catch (err) {
      setResult({ success: false, error: String(err) });
    }

    setPosting(false);
  };

  return (
    <div className="space-y-4">
      {/* Result banner */}
      {result && (
        <div
          className={`p-4 rounded-lg text-sm ${
            result.success
              ? "bg-moss-600/20 border border-moss-400/30 text-moss-400"
              : "bg-red-900/20 border border-red-500/30 text-red-400"
          }`}
        >
          {result.success ? (
            <>
              Posted!{" "}
              <a href={result.url} className="underline">
                View post
              </a>
            </>
          ) : (
            result.error
          )}
        </div>
      )}

      {/* Mode indicator */}
      <div className="flex items-center gap-2">
        <span
          className={`text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${
            isArticle
              ? "bg-accent-400/10 text-accent-400 border border-accent-400/30"
              : "bg-surface-600/50 text-gray-400 border border-surface-600"
          }`}
        >
          {isArticle ? "Article" : "Note"}
        </span>
        {isArticle && (
          <span className="text-xs text-gray-600">
            Full markdown supported — fedi sees description + link
          </span>
        )}
      </div>

      {/* Title (optional) */}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a title to make this an article..."
        className="w-full bg-transparent border-b border-surface-700 pb-2 text-xl font-display text-white placeholder-gray-700 focus:border-accent-400/30 focus:outline-none transition-colors"
      />

      {/* Content */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          placeholder={isArticle ? "Write your article (markdown supported)..." : "What's on your mind?"}
          rows={4}
          className="w-full bg-surface-800/50 border border-surface-700 rounded-lg p-4 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none resize-none transition-colors"
        />
        {/* Character count — only for notes */}
        {!isArticle && (
          <div className="absolute bottom-3 right-3">
            <span
              className={`text-xs font-mono ${
                charCount > 300
                  ? "text-red-400"
                  : charCount > 250
                    ? "text-amber-400"
                    : "text-gray-600"
              }`}
            >
              {charCount}/300
            </span>
          </div>
        )}
      </div>

      {/* Description field — only for articles */}
      {isArticle && (
        <div>
          <label className="text-xs text-gray-500 mb-1 block">
            Description (what fedi/Bluesky/Threads see — max 300 chars)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief summary of your article... (auto-generated if left empty)"
            rows={2}
            maxLength={300}
            className="w-full bg-surface-800/50 border border-surface-700 rounded-lg p-3 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none resize-none"
          />
          <div className="text-right">
            <span className={`text-xs font-mono ${description.length > 280 ? "text-amber-400" : "text-gray-600"}`}>
              {description.length}/300
            </span>
          </div>
        </div>
      )}

      {/* Photo attachments */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-500">Photos ({photos.length}/4)</span>
          {photos.length < 4 && (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="text-xs text-accent-400 hover:text-accent-300 transition-colors"
            >
              {uploading ? "Uploading..." : "+ Add photo"}
            </button>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          onChange={(e) => handleFileSelect(e.target.files)}
          className="hidden"
        />

        {photos.length === 0 && (
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className="border-2 border-dashed border-surface-600/50 rounded-lg p-6 text-center hover:border-surface-600 transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <p className="text-xs text-gray-600">
              Drop photos here or click to upload (max 4)
            </p>
          </div>
        )}

        {photos.length > 0 && (
          <div
            className="grid grid-cols-2 gap-3"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            {photos.map((photo, i) => (
              <div key={i} className="relative">
                <img
                  src={photo.preview}
                  alt=""
                  className="w-full h-32 object-cover rounded-lg"
                />
                <button
                  onClick={() => removePhoto(i)}
                  className="absolute top-1 right-1 w-6 h-6 bg-black/70 rounded-full flex items-center justify-center text-white hover:bg-red-500 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <input
                  type="text"
                  value={photo.alt}
                  onChange={(e) => {
                    setPhotos((prev) =>
                      prev.map((p, j) =>
                        j === i ? { ...p, alt: e.target.value } : p
                      )
                    );
                  }}
                  placeholder="Alt text / caption..."
                  className="mt-1 w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Crosspost toggles */}
      <div className="flex items-center gap-4 pt-2 border-t border-surface-700">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={crosspostBluesky}
            onChange={(e) => setCrosspostBluesky(e.target.checked)}
            className="rounded border-surface-600 bg-surface-800 text-accent-400 focus:ring-accent-400/30"
          />
          <span className="text-xs text-gray-500">Bluesky</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={crosspostThreads}
            onChange={(e) => setCrosspostThreads(e.target.checked)}
            className="rounded border-surface-600 bg-surface-800 text-accent-400 focus:ring-accent-400/30"
          />
          <span className="text-xs text-gray-500">Threads</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={crosspostDayOne}
            onChange={(e) => setCrosspostDayOne(e.target.checked)}
            className="rounded border-surface-600 bg-surface-800 text-accent-400 focus:ring-accent-400/30"
          />
          <span className="text-xs text-gray-500">DayOne</span>
        </label>
      </div>

      {/* Photography toggle — only show when photos are attached */}
      {photos.length > 0 && (
        <div className="flex items-center gap-4 pt-2 border-t border-surface-700">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={addToPhotography}
              onChange={(e) => setAddToPhotography(e.target.checked)}
              className="rounded border-surface-600 bg-surface-800 text-accent-400 focus:ring-accent-400/30"
            />
            <span className="text-xs text-gray-500">Add to Photography</span>
          </label>
          {addToPhotography && (
            <select
              value={photoCategory}
              onChange={(e) => setPhotoCategory(e.target.value)}
              className="text-xs bg-surface-800 border border-surface-600 rounded px-2 py-1 text-gray-400"
            >
              <option value="general">General</option>
              <option value="wildlife">Wildlife</option>
              <option value="macro">Macro</option>
              <option value="landscape">Landscape</option>
              <option value="street">Street</option>
            </select>
          )}
        </div>
      )}

      {/* Post button */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-600">
          {isArticle
            ? "Article will be published on your site. Fedi + crossposts get the description."
            : "Note will be sent to Fediverse, Bluesky, and Threads."}
        </p>
        <button
          onClick={handleSubmit}
          disabled={!content.trim() || posting}
          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {posting ? "Posting..." : "Publish"}
        </button>
      </div>
    </div>
  );
}
