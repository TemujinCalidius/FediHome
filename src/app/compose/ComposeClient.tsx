"use client";

import { useState, useRef, useCallback } from "react";
import { useMentionAutocomplete } from "@/components/ui/MentionAutocomplete";

interface PhotoAttachment {
  url: string;
  alt: string;
  file?: File;
  preview: string;
}

interface VideoAttachment {
  url: string;
  title: string;
  embedHost: string;
  embedId: string;
  iframeSrc: string;
  thumbnailUrl: string | null;
  duration: number | null;
}

interface AudioAttachment {
  url: string;
  title: string;
  durationSec: number | null;
  fileSize: number | null;
}

export interface InitialValues {
  title: string;
  content: string;
  description: string;
  photos: { url: string; alt: string }[];
  videos: { url: string; title: string; thumbnailUrl: string | null }[];
  audios: { url: string; title: string; coverImage: string | null }[];
}

interface ComposeClientProps {
  editingPostId?: string | null;
  initialValues?: InitialValues | null;
}

export default function ComposeClient({ editingPostId = null, initialValues = null }: ComposeClientProps) {
  const isEditing = !!editingPostId;
  const [title, setTitle] = useState(initialValues?.title ?? "");
  const [content, setContent] = useState(initialValues?.content ?? "");
  const [description, setDescription] = useState(initialValues?.description ?? "");
  const [photos, setPhotos] = useState<PhotoAttachment[]>(
    (initialValues?.photos ?? []).map((p) => ({ url: p.url, alt: p.alt, preview: p.url }))
  );
  const [videos, setVideos] = useState<VideoAttachment[]>(
    (initialValues?.videos ?? []).map((v) => ({
      url: v.url,
      title: v.title,
      embedHost: "",
      embedId: "",
      iframeSrc: "",
      thumbnailUrl: v.thumbnailUrl,
      duration: null,
    }))
  );
  const [audios, setAudios] = useState<AudioAttachment[]>(
    (initialValues?.audios ?? []).map((a) => ({
      url: a.url,
      title: a.title,
      durationSec: null,
      fileSize: null,
    }))
  );
  const [crosspostBluesky, setCrosspostBluesky] = useState(true);
  const [crosspostThreads, setCrosspostThreads] = useState(true);
  const [crosspostDayOne, setCrosspostDayOne] = useState(true);
  const [addToPhotography, setAddToPhotography] = useState(false);
  const [photoCategory, setPhotoCategory] = useState("general");
  const [addToVideos, setAddToVideos] = useState(false);
  const [videoCategory, setVideoCategory] = useState("general");
  const [addToAudio, setAddToAudio] = useState(false);
  const [audioCategory, setAudioCategory] = useState("general");
  const [uploading, setUploading] = useState(false);
  const [audioUploading, setAudioUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; url?: string; error?: string } | null>(null);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [videoUrlInput, setVideoUrlInput] = useState("");
  const [videoParsing, setVideoParsing] = useState(false);
  const [videoParseError, setVideoParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
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

  // @mention autocomplete wired to the main textarea
  const { dropdownNode: mentionDropdown } = useMentionAutocomplete(
    textareaRef,
    content,
    handleContentChange,
  );

  // Upload photo to /api/media
  const uploadPhoto = useCallback(async (file: File): Promise<string | null> => {
    const form = new FormData();
    form.append("file", file);

    // Use Micropub token from cookie — the media endpoint needs a Bearer token
    // We'll call our own proxy instead
    try {
      const res = await fetch("/api/media", {
        method: "POST",
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

  // Parse a PeerTube URL on the server → fetches title + thumbnail
  const parseVideoUrl = async () => {
    const url = videoUrlInput.trim();
    if (!url) return;
    setVideoParsing(true);
    setVideoParseError(null);
    try {
      const res = await fetch("/api/video/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setVideoParseError(err.error || "Could not parse video URL");
        setVideoParsing(false);
        return;
      }
      const data = await res.json();
      setVideos((prev) => [
        ...prev,
        {
          url: data.embedUrl,
          title: data.title || "",
          embedHost: data.embedHost,
          embedId: data.embedId,
          iframeSrc: data.iframeSrc,
          thumbnailUrl: data.thumbnailUrl || null,
          duration: data.duration || null,
        },
      ]);
      setVideoUrlInput("");
      setVideoModalOpen(false);
    } catch {
      setVideoParseError("Failed to reach the parser");
    }
    setVideoParsing(false);
  };

  const removeVideo = (index: number) => {
    setVideos((prev) => prev.filter((_, i) => i !== index));
  };

  // Upload audio MP3 to /api/media
  const handleAudioSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith("audio/")) return;

    setAudioUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/media", { method: "POST", body: form });
      if (res.ok) {
        const data = await res.json();
        setAudios((prev) => [
          ...prev,
          {
            url: data.url,
            title: file.name.replace(/\.[^.]+$/, ""),
            durationSec: data.durationSec || null,
            fileSize: data.fileSize || null,
          },
        ]);
      }
    } finally {
      setAudioUploading(false);
    }
  };

  const removeAudio = (index: number) => {
    setAudios((prev) => prev.filter((_, i) => i !== index));
  };

  const formatDuration = (sec: number | null) => {
    if (!sec || sec < 0) return "";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
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
          videos: videos.map((v) => ({
            url: v.url,
            title: v.title,
            embedHost: v.embedHost,
            embedId: v.embedId,
            iframeSrc: v.iframeSrc,
            thumbnailUrl: v.thumbnailUrl,
            duration: v.duration,
          })),
          audios: audios.map((a) => ({
            url: a.url,
            title: a.title,
            durationSec: a.durationSec,
            fileSize: a.fileSize,
          })),
          crosspostBluesky,
          crosspostThreads,
          crosspostDayOne,
          addToPhotography: photos.length > 0 && addToPhotography,
          photoCategory: addToPhotography ? photoCategory : undefined,
          addToVideos: videos.length > 0 && addToVideos,
          videoCategory: addToVideos ? videoCategory : undefined,
          addToAudio: audios.length > 0 && addToAudio,
          audioCategory: addToAudio ? audioCategory : undefined,
          editingPostId: editingPostId || undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        if (isEditing && data.post?.url) {
          // Edit: navigate back to the post
          window.location.href = data.post.url;
          return;
        }
        setResult({ success: true, url: data.post.url });
        // Reset form (create only)
        setTitle("");
        setContent("");
        setDescription("");
        setPhotos([]);
        setVideos([]);
        setAudios([]);
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
          className={`p-4 rounded-lg text-sm break-words ${
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

      {/* Edit-mode banner */}
      {isEditing && (
        <div className="p-3 rounded-lg text-xs bg-accent-400/10 border border-accent-400/30 text-accent-300">
          <span className="font-semibold">Editing existing post.</span>{" "}
          The Fediverse will see an Update activity (Mastodon shows &ldquo;edited X ago&rdquo;). Bluesky/Threads/DayOne crossposts are NOT re-sent. Auto-created Photo/Video/Audio records aren&apos;t modified — manage those from their respective admin tabs.
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
        {mentionDropdown}
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
                {/* eslint-disable-next-line @next/next/no-img-element -- local object-URL preview of a user-selected upload */}
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

      {/* Video attachments */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-500">Videos ({videos.length})</span>
          <button
            type="button"
            onClick={() => setVideoModalOpen(true)}
            className="text-xs text-accent-400 hover:text-accent-300 transition-colors"
          >
            + Add video
          </button>
          <span className="text-[10px] text-gray-700">PeerTube / MakerTube embeds</span>
        </div>

        {videos.length > 0 && (
          <div className="space-y-2">
            {videos.map((video, i) => (
              <div key={i} className="flex items-center gap-3 bg-surface-800/50 border border-surface-700 rounded-lg p-2">
                {video.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={video.thumbnailUrl} alt="" className="w-20 h-12 object-cover rounded flex-shrink-0" />
                ) : (
                  <div className="w-20 h-12 bg-surface-700 rounded flex items-center justify-center text-[10px] text-gray-600 flex-shrink-0">
                    no preview
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <input
                    type="text"
                    value={video.title}
                    onChange={(e) => {
                      const v = e.target.value;
                      setVideos((prev) => prev.map((x, j) => (j === i ? { ...x, title: v } : x)));
                    }}
                    placeholder="Video title"
                    className="w-full bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none"
                  />
                  <div className="text-[10px] text-gray-600 truncate">
                    {video.embedHost}
                    {video.duration ? ` · ${formatDuration(video.duration)}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeVideo(i)}
                  className="w-6 h-6 bg-surface-700 hover:bg-red-500 rounded flex items-center justify-center text-white text-xs"
                  aria-label="Remove video"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Audio attachments */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-gray-500">Audio ({audios.length})</span>
          <button
            type="button"
            onClick={() => audioInputRef.current?.click()}
            disabled={audioUploading}
            className="text-xs text-accent-400 hover:text-accent-300 transition-colors disabled:opacity-50"
          >
            {audioUploading ? "Uploading..." : "+ Add audio"}
          </button>
          <span className="text-[10px] text-gray-700">MP3, max 100MB</span>
        </div>

        <input
          ref={audioInputRef}
          type="file"
          accept="audio/mpeg,audio/mp3,.mp3"
          onChange={(e) => handleAudioSelect(e.target.files)}
          className="hidden"
        />

        {audios.length > 0 && (
          <div className="space-y-2">
            {audios.map((audio, i) => (
              <div key={i} className="flex items-center gap-3 bg-surface-800/50 border border-surface-700 rounded-lg p-2">
                <div className="w-10 h-10 bg-surface-700 rounded flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <input
                    type="text"
                    value={audio.title}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAudios((prev) => prev.map((x, j) => (j === i ? { ...x, title: v } : x)));
                    }}
                    placeholder="Track title"
                    className="w-full bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none"
                  />
                  <div className="text-[10px] text-gray-600">
                    {audio.durationSec ? `${formatDuration(audio.durationSec)}` : "?"}
                    {audio.fileSize ? ` · ${(audio.fileSize / (1024 * 1024)).toFixed(1)} MB` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeAudio(i)}
                  className="w-6 h-6 bg-surface-700 hover:bg-red-500 rounded flex items-center justify-center text-white text-xs"
                  aria-label="Remove audio"
                >
                  ×
                </button>
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

      {/* Video toggle — only show when videos are attached */}
      {videos.length > 0 && (
        <div className="flex items-center gap-4 pt-2 border-t border-surface-700">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={addToVideos}
              onChange={(e) => setAddToVideos(e.target.checked)}
              className="rounded border-surface-600 bg-surface-800 text-accent-400 focus:ring-accent-400/30"
            />
            <span className="text-xs text-gray-500">Add to Videos</span>
          </label>
          {addToVideos && (
            <select
              value={videoCategory}
              onChange={(e) => setVideoCategory(e.target.value)}
              className="text-xs bg-surface-800 border border-surface-600 rounded px-2 py-1 text-gray-400"
            >
              <option value="general">General</option>
              <option value="lore">Lore</option>
              <option value="tutorial">Tutorial</option>
              <option value="walk">Photo walk</option>
            </select>
          )}
        </div>
      )}

      {/* Audio toggle — only show when audios are attached */}
      {audios.length > 0 && (
        <div className="flex items-center gap-4 pt-2 border-t border-surface-700">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={addToAudio}
              onChange={(e) => setAddToAudio(e.target.checked)}
              className="rounded border-surface-600 bg-surface-800 text-accent-400 focus:ring-accent-400/30"
            />
            <span className="text-xs text-gray-500">Add to Audio</span>
          </label>
          {addToAudio && (
            <select
              value={audioCategory}
              onChange={(e) => setAudioCategory(e.target.value)}
              className="text-xs bg-surface-800 border border-surface-600 rounded px-2 py-1 text-gray-400"
            >
              <option value="general">General</option>
              <option value="music">Music</option>
              <option value="talk">Talk</option>
              <option value="ambient">Ambient</option>
            </select>
          )}
        </div>
      )}

      {/* Video URL modal */}
      {videoModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setVideoModalOpen(false)}
        >
          <div
            className="bg-surface-900 border border-surface-700 rounded-xl p-5 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-white mb-3">Add a video</h3>
            <p className="text-xs text-gray-500 mb-3">
              Paste a PeerTube / MakerTube URL. We&apos;ll fetch the title and thumbnail.
            </p>
            <input
              type="url"
              value={videoUrlInput}
              onChange={(e) => setVideoUrlInput(e.target.value)}
              placeholder="https://makertube.net/w/..."
              className="w-full bg-surface-800 border border-surface-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none mb-3"
              autoFocus
            />
            {videoParseError && (
              <p className="text-xs text-red-400 mb-3">{videoParseError}</p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setVideoModalOpen(false);
                  setVideoUrlInput("");
                  setVideoParseError(null);
                }}
                className="text-xs text-gray-500 hover:text-white px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={parseVideoUrl}
                disabled={videoParsing || !videoUrlInput.trim()}
                className="btn-primary text-xs disabled:opacity-50"
              >
                {videoParsing ? "Parsing..." : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post button */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-600">
          {isEditing
            ? "Saving sends an AP Update to the Fediverse. Bluesky/Threads/DayOne crossposts are NOT re-sent."
            : isArticle
              ? `Article will be published on your site.${crosspostBluesky || crosspostThreads || crosspostDayOne ? " Crossposts get the description." : ""}`
              : `Note will be sent to ${["Fediverse", crosspostBluesky && "Bluesky", crosspostThreads && "Threads", crosspostDayOne && "DayOne"].filter(Boolean).join(", ")}.`}
        </p>
        <button
          onClick={handleSubmit}
          disabled={!content.trim() || posting}
          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {posting ? (isEditing ? "Saving…" : "Posting…") : isEditing ? "Save changes" : "Publish"}
        </button>
      </div>
    </div>
  );
}
