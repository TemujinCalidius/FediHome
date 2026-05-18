"use client";

import { useState, useEffect, useCallback } from "react";
import { LightboxGallery } from "@/components/ui/Lightbox";

function PostMedia({ urls, types, maxH }: { urls: string[]; types: string[]; maxH: string }) {
  const images = urls.map((url, i) => ({ url, type: types[i], i })).filter((m) => m.type !== "video");
  const videos = urls.map((url, i) => ({ url, type: types[i], i })).filter((m) => m.type === "video");
  return (
    <div className="mt-3 space-y-2">
      {images.length > 0 && (
        <LightboxGallery>
          <div className={`grid gap-2 ${images.length > 1 ? "grid-cols-2" : ""}`}>
            {images.map((m) => (
              <img key={m.i} src={m.url} alt="" className={`rounded-lg ${maxH} object-cover w-full`} />
            ))}
          </div>
        </LightboxGallery>
      )}
      {videos.map((m) => (
        <video key={m.i} src={m.url} controls playsInline preload="auto" className={`rounded-lg ${maxH} w-full bg-black`} />
      ))}
    </div>
  );
}

interface FediPostItem {
  id: string;
  apId: string;
  content: string;
  contentHtml: string | null;
  mediaUrls: string[];
  mediaTypes: string[];
  username: string;
  domain: string;
  displayName: string | null;
  avatarUrl: string | null;
  publishedAt: string;
  inReplyTo: string | null;
  conversationId: string | null;
  embedUrl: string | null;
  embedTitle: string | null;
  embedDescription: string | null;
  embedImage: string | null;
  embedSiteName: string | null;
  boostedBy: string | null;
  boostedByName: string | null;
  likeCount?: number | null;
  boostCount?: number | null;
  replyCount?: number | null;
  countsFetchedAt?: string | null;
  isOutgoing?: boolean;
}

interface FediCountsState {
  likeCount: number | null;
  boostCount: number | null;
  replyCount: number | null;
  countsFetchedAt: string | null;
  loading?: boolean;
}

interface ReplyItem extends FediPostItem {
  parent: {
    apId: string;
    username: string;
    domain: string;
    displayName: string | null;
    avatarUrl: string | null;
    snippet: string;
    publishedAt: string;
  } | null;
}

type FollowingItem =
  | {
      source: "fedi";
      id: string;
      actorUri: string;
      username: string;
      domain: string;
      displayName: string | null;
      avatarUrl: string | null;
      createdAt: string;
    }
  | {
      source: "bsky";
      id: string;
      did: string;
      handle: string;
      followUri: string | null;
      displayName: string | null;
      avatarUrl: string | null;
      createdAt: string;
    };

interface PendingComment {
  id: string;
  guestName: string;
  content: string;
  createdAt: string;
  post: { slug: string; title: string | null } | null;
  photo: { slug: string; title: string | null } | null;
}

type FollowerItem =
  | {
      source: "fedi";
      id: string;
      actorUri: string;
      username: string;
      domain: string;
      displayName: string | null;
      avatarUrl: string | null;
      createdAt: string;
    }
  | {
      source: "bsky";
      id: string;
      did: string;
      handle: string;
      displayName: string | null;
      avatarUrl: string | null;
      createdAt: string;
    };

interface AnalyticsData {
  stats: { totalHits: number; totalKudos: number } | null;
  leaderboard: { path: string; hits: number; percentage: number }[];
  recentHits: { id: number; path: string; referrer: string; country: string; browser_name: string; platform_name: string; created_at: string }[];
  journeys: { visitor_hash: string; page_count: number; pages: { path: string }[]; entry_page: string; exit_page: string; session_duration: string; referrer: string; country: string; browser: string; first_hit: string }[];
}

interface DirectMessageItem {
  id: string;
  source: string;
  senderUri: string;
  senderHandle: string;
  senderName: string | null;
  senderAvatar: string | null;
  content: string;
  contentHtml: string | null;
  conversationKey: string;
  bskyConvoId: string | null;
  isOutgoing: boolean;
  createdAt: string;
  deliveredAt: string | null;
  deliveryError: string | null;
}

interface Conversation {
  key: string;
  source: string;
  handle: string;
  name: string | null;
  avatar: string | null;
  senderUri: string;
  bskyConvoId: string | null;
  messages: DirectMessageItem[];
  lastMessage: DirectMessageItem;
  hasUnread: boolean;
}

function UserProfilePopup({
  name,
  handle,
  avatar,
  actorUri,
  source,
  onClose,
}: {
  name: string | null;
  handle: string;
  avatar: string | null;
  actorUri: string;
  source: "fedi" | "bluesky";
  onClose: () => void;
}) {
  const profileUrl =
    source === "bluesky"
      ? `https://bsky.app/profile/${handle.replace(/^@/, "")}`
      : actorUri;
  const profileDomain =
    source === "bluesky" ? "Bluesky" : new URL(actorUri).hostname;

  const handleBlock = async () => {
    if (!confirm(`Block ${handle}? This will unfollow them and remove all their posts from your feed.`)) return;
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "block", actorUri }),
    });
    window.location.reload();
  };

  const handleUnfollow = async () => {
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unfollow_by_uri", actorUri }),
    });
    window.location.reload();
  };

  return (
    <div className="absolute top-12 left-0 z-40 bg-surface-900 border border-surface-600/30 rounded-xl shadow-2xl shadow-black/50 p-4 w-64">
      <div className="flex items-center gap-3 mb-3">
        {avatar ? (
          <img src={avatar} alt="" className="w-12 h-12 rounded-full" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-surface-700" />
        )}
        <div>
          <p className="text-sm font-semibold text-white">{name || handle}</p>
          <p className="text-xs text-gray-500">{handle}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <a
          href={profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent-400 hover:text-accent-300 transition-colors"
        >
          View profile on {profileDomain}
        </a>
        {source === "fedi" && (
          <>
            <button
              onClick={handleUnfollow}
              className="text-xs text-gray-400 hover:text-yellow-400 transition-colors text-left"
            >
              Unfollow
            </button>
            <button
              onClick={handleBlock}
              className="text-xs text-gray-400 hover:text-red-400 transition-colors text-left"
            >
              Block
            </button>
          </>
        )}
      </div>
      <button
        onClick={onClose}
        className="absolute top-2 right-2 text-gray-600 hover:text-white transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function PostCard({
  post,
  replyTo,
  setReplyTo,
  replyContent,
  setReplyContent,
  allPosts,
  onViewThread,
  counts,
  onLoadCounts,
}: {
  post: FediPostItem;
  replyTo: { apId: string; inbox: string } | null;
  setReplyTo: (v: { apId: string; inbox: string } | null) => void;
  replyContent: string;
  setReplyContent: (v: string) => void;
  allPosts: FediPostItem[];
  onViewThread: (postId: string) => void;
  counts: FediCountsState | undefined;
  onLoadCounts: (postId: string) => void;
}) {
  const [showUserPopup, setShowUserPopup] = useState(false);
  const [liked, setLiked] = useState(false);
  const [boosted, setBoosted] = useState(false);

  // Find parent post info for reply context
  const parentPost = post.inReplyTo
    ? allPosts.find((p) => p.apId === post.inReplyTo)
    : null;

  // Counts may have been pre-loaded (DB cache via initial fetch) or are
  // unfetched. Prefer the live state from a recent on-demand fetch.
  const liveCounts: FediCountsState = counts ?? {
    likeCount: post.likeCount ?? null,
    boostCount: post.boostCount ?? null,
    replyCount: post.replyCount ?? null,
    countsFetchedAt: post.countsFetchedAt ?? null,
  };
  const countsLoaded = Boolean(liveCounts.countsFetchedAt);
  const countsLoading = Boolean(liveCounts.loading);

  const actorUri = `https://${post.domain}/users/${post.username}`;
  const inbox = `https://${post.domain}/users/${post.username}/inbox`;

  const handleLike = async () => {
    if (liked) return;
    setLiked(true);
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "like", postApId: post.apId, targetInbox: inbox }),
    });
  };

  const handleBoost = async () => {
    if (boosted) return;
    setBoosted(true);
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "boost", postApId: post.apId, targetInbox: inbox }),
    });
  };

  return (
    <div className="glass-card p-5">
      {/* Reply context indicator */}
      {post.inReplyTo && (
        <div className="flex items-center gap-1.5 mb-2 text-xs text-gray-600">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
          Replying to{" "}
          {parentPost ? (
            <span className="text-accent-400">
              @{parentPost.username}@{parentPost.domain}
            </span>
          ) : (
            <span className="text-gray-500">another post</span>
          )}
        </div>
      )}

      {/* Boost banner */}
      {post.boostedByName && (
        <div className="flex items-center gap-1.5 mb-2 text-xs text-gray-500">
          <span>🔁</span>
          <span>{post.boostedByName} boosted</span>
        </div>
      )}

      {/* Author header */}
      <div className="flex items-center gap-3 mb-3 relative">
        {post.avatarUrl ? (
          <img src={post.avatarUrl} alt="" className="w-10 h-10 rounded-full" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-surface-700" />
        )}
        <div>
          <button
            onClick={() => setShowUserPopup(!showUserPopup)}
            className="text-sm font-semibold text-white hover:text-accent-400 transition-colors text-left"
          >
            {post.displayName || post.username}
          </button>
          <p className="text-xs text-gray-600">
            <button
              onClick={() => setShowUserPopup(!showUserPopup)}
              className="hover:text-accent-400 transition-colors"
            >
              @{post.username}@{post.domain}
            </button>
            {" "}&middot; {new Date(post.publishedAt).toLocaleDateString()}
          </p>
        </div>

        {/* User popup */}
        {showUserPopup && (
          <UserProfilePopup
            name={post.displayName || post.username}
            handle={`@${post.username}@${post.domain}`}
            avatar={post.avatarUrl}
            actorUri={actorUri}
            source="fedi"
            onClose={() => setShowUserPopup(false)}
          />
        )}
      </div>

      {/* Content */}
      <div
        className="text-gray-400 text-sm leading-relaxed [&_a]:text-accent-400 [&_a]:hover:underline"
        dangerouslySetInnerHTML={{
          __html: post.contentHtml || "",
        }}
      />

      {/* Media (images + videos) */}
      {post.mediaUrls.length > 0 && (
        <PostMedia urls={post.mediaUrls} types={post.mediaTypes || []} maxH="max-h-80" />

      )}

      {/* Link preview embed */}
      {post.embedUrl && (post.embedTitle || post.embedDescription) && (
        <a
          href={post.embedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block border border-surface-600/50 rounded-lg overflow-hidden hover:border-surface-600 transition-colors bg-surface-800/50"
        >
          {post.embedImage && (
            <img
              src={post.embedImage}
              alt=""
              className="w-full h-40 object-cover"
            />
          )}
          <div className="p-3">
            {post.embedTitle && (
              <p className="text-sm font-semibold text-white line-clamp-2">
                {post.embedTitle}
              </p>
            )}
            {post.embedDescription && (
              <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                {post.embedDescription}
              </p>
            )}
            <p className="text-xs text-gray-600 mt-1">
              {post.embedSiteName || (() => { try { return new URL(post.embedUrl!).hostname; } catch { return ""; } })()}
            </p>
          </div>
        </a>
      )}

      {/* Actions bar */}
      <div className="mt-3 pt-2 border-t border-surface-700 flex items-center gap-4">
        {/* Like */}
        <button
          onClick={handleLike}
          className={`flex items-center gap-1 text-xs transition-colors ${
            liked ? "text-red-400" : "text-gray-500 hover:text-red-400"
          }`}
          title="Like"
        >
          <svg className="w-4 h-4" fill={liked ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
          </svg>
        </button>

        {/* Boost */}
        <button
          onClick={handleBoost}
          className={`flex items-center gap-1 text-xs transition-colors ${
            boosted ? "text-green-400" : "text-gray-500 hover:text-green-400"
          }`}
          title="Boost"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
          </svg>
        </button>

        {/* Reply */}
        {replyTo?.apId === post.apId ? (
          <div className="flex gap-2 flex-1">
            <input
              type="text"
              value={replyContent}
              onChange={(e) => setReplyContent(e.target.value)}
              placeholder="Write a reply..."
              className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none"
            />
            <button
              onClick={async () => {
                if (!replyContent.trim()) return;
                await fetch("/api/admin", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    action: "reply",
                    content: replyContent.trim(),
                    inReplyTo: post.apId,
                    targetInbox: `https://${post.domain}/users/${post.username}/inbox`,
                    actorUri: `https://${post.domain}/users/${post.username}`,
                    mentionHandle: `@${post.username}@${post.domain}`,
                  }),
                });
                setReplyContent("");
                setReplyTo(null);
              }}
              className="btn-primary text-xs !py-1.5"
            >
              Send
            </button>
            <button
              onClick={() => { setReplyTo(null); setReplyContent(""); }}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() =>
              setReplyTo({
                apId: post.apId,
                inbox: `https://${post.domain}/users/${post.username}/inbox`,
              })
            }
            className="text-xs text-gray-500 hover:text-accent-400 transition-colors"
          >
            Reply
          </button>
        )}

        {/* View thread (works for any post — endpoint walks ancestors + descendants) */}
        <button
          onClick={() => {
            onViewThread(post.id);
            if (!countsLoaded && !countsLoading) onLoadCounts(post.id);
          }}
          className="text-xs text-gray-500 hover:text-accent-400 transition-colors"
        >
          View thread
        </button>
      </div>

      {/* Interaction counts strip — fetched on demand from the remote AP object */}
      <div className="mt-2 flex items-center gap-3 text-xs">
        {countsLoaded ? (
          <span className="text-gray-500">
            <span title="Replies">💬 {fmtCount(liveCounts.replyCount)}</span>
            <span className="mx-2 text-gray-700">·</span>
            <span title="Boosts">🔁 {fmtCount(liveCounts.boostCount)}</span>
            <span className="mx-2 text-gray-700">·</span>
            <span title="Likes">❤ {fmtCount(liveCounts.likeCount)}</span>
          </span>
        ) : (
          <button
            onClick={() => onLoadCounts(post.id)}
            disabled={countsLoading}
            className="text-gray-600 hover:text-accent-400 transition-colors disabled:opacity-40"
            title="Fetch interaction counts from the remote server"
          >
            {countsLoading ? "Loading interactions…" : "💬 🔁 ❤  Tap to load"}
          </button>
        )}
      </div>
    </div>
  );
}

function fmtCount(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return String(n);
}

function ThreadView({
  thread,
  onClose,
  counts,
  onLoadCounts,
}: {
  thread: FediPostItem[];
  onClose: () => void;
  counts: Map<string, FediCountsState>;
  onLoadCounts: (postId: string) => void;
}) {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [sending, setSending] = useState(false);

  const handleReply = async (post: FediPostItem) => {
    if (!replyContent.trim() || sending) return;
    setSending(true);
    try {
      await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reply",
          content: replyContent.trim(),
          inReplyTo: post.apId,
          targetInbox: `https://${post.domain}/users/${post.username}/inbox`,
          actorUri: `https://${post.domain}/users/${post.username}`,
          mentionHandle: `@${post.username}@${post.domain}`,
        }),
      });
      setReplyContent("");
      setReplyTo(null);
    } catch {
      // silently fail
    }
    setSending(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface-900 border border-surface-600/30 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col">
        {/* Fixed header */}
        <div className="flex-shrink-0 border-b border-surface-700 p-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Conversation</h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable thread content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-1">
          {thread.map((post, i) => (
            <div key={post.id || i} className="relative">
              {/* Thread connector line */}
              {i < thread.length - 1 && (
                <div className="absolute left-5 top-12 bottom-0 w-px bg-surface-600/50" />
              )}
              <div className="flex gap-3 pb-3">
                {post.avatarUrl ? (
                  <img src={post.avatarUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-surface-700 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-white truncate">
                      {post.displayName || post.username}
                    </p>
                    <p className="text-xs text-gray-600 truncate">
                      @{post.username}@{post.domain}
                    </p>
                    <p className="text-xs text-gray-700">
                      {new Date(post.publishedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div
                    className="text-gray-400 text-sm leading-relaxed mt-1 [&_a]:text-accent-400 [&_a]:hover:underline"
                    dangerouslySetInnerHTML={{
                      __html: post.contentHtml || "",
                    }}
                  />

                  {/* Media */}
                  {post.mediaUrls.length > 0 && (
                    <PostMedia urls={post.mediaUrls} types={post.mediaTypes || []} maxH="max-h-60" />
                  )}

                  {/* Embed card */}
                  {post.embedUrl && (post.embedTitle || post.embedDescription) && (
                    <a
                      href={post.embedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 block border border-surface-600/50 rounded-lg overflow-hidden hover:border-surface-600 transition-colors bg-surface-800/50"
                    >
                      {post.embedImage && (
                        <img src={post.embedImage} alt="" className="w-full h-32 object-cover" />
                      )}
                      <div className="p-2">
                        {post.embedTitle && (
                          <p className="text-xs font-semibold text-white line-clamp-1">{post.embedTitle}</p>
                        )}
                        {post.embedDescription && (
                          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{post.embedDescription}</p>
                        )}
                        <p className="text-xs text-gray-600 mt-0.5">
                          {post.embedSiteName || (() => { try { return new URL(post.embedUrl!).hostname; } catch { return ""; } })()}
                        </p>
                      </div>
                    </a>
                  )}

                  {/* Reply action + interaction counts */}
                  <div className="mt-2 flex items-center gap-3 flex-wrap">
                    {replyTo === post.apId ? (
                      <div className="flex gap-2 flex-1 min-w-0">
                        <input
                          type="text"
                          value={replyContent}
                          onChange={(e) => setReplyContent(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleReply(post); }}
                          placeholder="Write a reply..."
                          autoFocus
                          className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none"
                        />
                        <button
                          onClick={() => handleReply(post)}
                          disabled={sending}
                          className="btn-primary text-xs !py-1.5"
                        >
                          {sending ? "..." : "Send"}
                        </button>
                        <button
                          onClick={() => { setReplyTo(null); setReplyContent(""); }}
                          className="text-xs text-gray-500 hover:text-gray-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setReplyTo(post.apId);
                          setReplyContent(post.isOutgoing ? "" : `@${post.username}@${post.domain} `);
                        }}
                        className="text-xs text-gray-500 hover:text-accent-400 transition-colors"
                      >
                        Reply
                      </button>
                    )}
                    <ThreadCountsStrip
                      postId={post.id}
                      fallback={{
                        likeCount: post.likeCount ?? null,
                        boostCount: post.boostCount ?? null,
                        replyCount: post.replyCount ?? null,
                        countsFetchedAt: post.countsFetchedAt ?? null,
                      }}
                      live={counts.get(post.id)}
                      onLoad={() => onLoadCounts(post.id)}
                    />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadCountsStrip({
  postId,
  fallback,
  live,
  onLoad,
}: {
  postId: string;
  fallback: FediCountsState;
  live: FediCountsState | undefined;
  onLoad: () => void;
}) {
  void postId;
  const counts = live ?? fallback;
  if (counts.countsFetchedAt) {
    return (
      <span className="text-xs text-gray-500">
        💬 {fmtCount(counts.replyCount)}
        <span className="mx-1.5 text-gray-700">·</span>
        🔁 {fmtCount(counts.boostCount)}
        <span className="mx-1.5 text-gray-700">·</span>
        ❤ {fmtCount(counts.likeCount)}
      </span>
    );
  }
  return (
    <button
      onClick={onLoad}
      disabled={Boolean(live?.loading)}
      className="text-xs text-gray-600 hover:text-accent-400 transition-colors disabled:opacity-40"
    >
      {live?.loading ? "…" : "Load counts"}
    </button>
  );
}

function RepliesTab({
  replies,
  loading,
  cursor,
  onLoadMore,
  onViewThread,
}: {
  replies: ReplyItem[] | null;
  loading: boolean;
  cursor: string | null;
  onLoadMore: () => void;
  onViewThread: (postId: string) => void;
}) {
  if (replies === null && loading) {
    return <p className="text-center text-xs text-gray-500 py-8">Loading replies…</p>;
  }
  if (replies === null || replies.length === 0) {
    return (
      <div className="glass-card p-8 text-center">
        <p className="text-gray-500">
          No outgoing replies yet. When you reply to a post on the feed, it'll
          show up here so you can jump back into the conversation.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {replies.map((reply) => (
        <div key={reply.id} className="glass-card p-5">
          {/* Parent context line */}
          <div className="flex items-start gap-2 mb-3 text-xs text-gray-500 border-l-2 border-surface-600 pl-3">
            <svg className="w-3 h-3 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            <div className="min-w-0 flex-1">
              {reply.parent ? (
                <>
                  <p className="text-accent-400">
                    @{reply.parent.username}@{reply.parent.domain}
                  </p>
                  <p className="text-gray-600 mt-0.5 line-clamp-2">
                    {reply.parent.snippet}
                  </p>
                </>
              ) : (
                <p className="text-gray-600 italic">
                  Replying to a post not cached locally — open the thread to fetch it.
                </p>
              )}
            </div>
          </div>

          {/* My reply body */}
          <div
            className="text-gray-300 text-sm leading-relaxed [&_a]:text-accent-400 [&_a]:hover:underline"
            dangerouslySetInnerHTML={{
              __html: reply.contentHtml || reply.content,
            }}
          />

          {reply.mediaUrls.length > 0 && (
            <PostMedia urls={reply.mediaUrls} types={reply.mediaTypes || []} maxH="max-h-60" />
          )}

          <div className="mt-3 pt-2 border-t border-surface-700 flex items-center gap-4 text-xs">
            <span className="text-gray-600">
              {new Date(reply.publishedAt).toLocaleString()}
            </span>
            <button
              onClick={() => onViewThread(reply.id)}
              className="text-gray-500 hover:text-accent-400 transition-colors"
            >
              View thread
            </button>
          </div>
        </div>
      ))}

      {cursor && (
        <div className="text-center pt-2">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="px-6 py-2 text-sm text-accent-400 border border-accent-400/30 rounded-lg hover:bg-accent-400/10 transition-colors disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}

      {!cursor && replies.length > 0 && (
        <p className="text-center text-xs text-gray-600 pt-2">
          You've reached the end
        </p>
      )}
    </div>
  );
}

/**
 * Pure conversation grouping. Read state comes from props (server-backed),
 * so this is shared between MessagesTab and the unread-count tab badge.
 */
function buildConversations(
  directMessages: DirectMessageItem[],
  readState: Record<string, string>
): Conversation[] {
  const groups = new Map<string, DirectMessageItem[]>();
  for (const msg of directMessages) {
    const existing = groups.get(msg.conversationKey) || [];
    existing.push(msg);
    groups.set(msg.conversationKey, existing);
  }

  return Array.from(groups.entries())
    .map(([key, messages]) => {
      const sorted = messages.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      const lastMessage = sorted[sorted.length - 1];
      const lastIncoming = [...sorted].reverse().find((m) => !m.isOutgoing);
      const lastOutgoing = [...sorted].reverse().find((m) => m.isOutgoing);
      const lastReadAt = readState[key];
      const hasUnread = lastIncoming
        ? (() => {
            const incomingDate = new Date(lastIncoming.createdAt);
            const lastOutgoingDate = lastOutgoing ? new Date(lastOutgoing.createdAt) : null;
            const lastReadDate = lastReadAt ? new Date(lastReadAt) : null;
            const latestAck = [lastOutgoingDate, lastReadDate]
              .filter((d): d is Date => d !== null)
              .reduce<Date | null>((a, b) => (a && a > b ? a : b), null);
            return !latestAck || incomingDate > latestAck;
          })()
        : false;

      return {
        key,
        source: lastMessage.source,
        handle: lastIncoming?.senderHandle || lastMessage.senderHandle,
        name: lastIncoming?.senderName || lastMessage.senderName,
        avatar: lastIncoming?.senderAvatar || lastMessage.senderAvatar,
        senderUri: lastIncoming?.senderUri || lastMessage.senderUri,
        bskyConvoId: lastMessage.bskyConvoId,
        messages: sorted,
        lastMessage,
        hasUnread,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.lastMessage.createdAt).getTime() -
        new Date(a.lastMessage.createdAt).getTime()
    );
}

function NewMessageModal({
  following,
  followers,
  onClose,
}: {
  following: FollowingItem[];
  followers: FollowerItem[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"following" | "followers" | "other">("following");
  const [search, setSearch] = useState("");
  const [recipient, setRecipient] = useState<
    | { source: "fedi"; handle: string; name: string | null; avatar: string | null; actorUri?: string }
    | { source: "bsky"; handle: string; name: string | null; avatar: string | null; did?: string }
    | null
  >(null);
  const [otherHandle, setOtherHandle] = useState("");
  const [otherSource, setOtherSource] = useState<"fedi" | "bsky">("fedi");
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = tab === "following" ? following : tab === "followers" ? followers : [];
  const filtered = list.filter((p) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    if (p.source === "fedi") {
      return (
        p.username.toLowerCase().includes(q) ||
        p.domain.toLowerCase().includes(q) ||
        (p.displayName?.toLowerCase().includes(q) ?? false)
      );
    }
    return (
      p.handle.toLowerCase().includes(q) ||
      (p.displayName?.toLowerCase().includes(q) ?? false)
    );
  });

  const pickFromList = (p: FollowingItem | FollowerItem) => {
    if (p.source === "fedi") {
      setRecipient({
        source: "fedi",
        handle: `@${p.username}@${p.domain}`,
        name: p.displayName,
        avatar: p.avatarUrl,
        actorUri: p.actorUri,
      });
    } else {
      setRecipient({
        source: "bsky",
        handle: p.handle,
        name: p.displayName,
        avatar: p.avatarUrl,
        did: p.did,
      });
    }
    setError(null);
  };

  const pickOther = () => {
    const trimmed = otherHandle.trim().replace(/^@/, "");
    if (!trimmed) {
      setError("Handle required");
      return;
    }
    if (otherSource === "fedi") {
      if (!trimmed.includes("@")) {
        setError("Fedi handle must be user@domain");
        return;
      }
      setRecipient({ source: "fedi", handle: `@${trimmed}`, name: null, avatar: null });
    } else {
      setRecipient({ source: "bsky", handle: trimmed, name: null, avatar: null });
    }
    setError(null);
  };

  const send = async () => {
    if (!recipient || !content.trim() || sending) return;
    setSending(true);
    setError(null);

    const body: Record<string, string> =
      recipient.source === "fedi"
        ? recipient.actorUri
          ? { action: "dm_new_fedi", content: content.trim(), recipientUri: recipient.actorUri }
          : { action: "dm_new_fedi", content: content.trim(), recipientHandle: recipient.handle }
        : recipient.did
          ? { action: "bsky_dm_new", content: content.trim(), recipientDid: recipient.did }
          : { action: "bsky_dm_new", content: content.trim(), recipientHandle: recipient.handle };

    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Send failed (${res.status})`);
        setSending(false);
        return;
      }
      if (data.delivered === false) {
        setError(`Sent but delivery failed: ${data.deliveryError || "unknown"}`);
        setSending(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="glass-card max-w-lg w-full max-h-[80vh] flex flex-col p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">New direct message</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xs">Close</button>
        </div>

        {!recipient ? (
          <>
            <div className="flex gap-2 mb-3">
              {(["following", "followers", "other"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1 text-[11px] uppercase tracking-wider rounded-lg border transition-colors ${
                    tab === t
                      ? "border-accent-400/30 bg-accent-400/10 text-accent-400"
                      : "border-surface-700 text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {tab === "other" ? (
              <div className="space-y-2">
                <p className="text-xs text-gray-500">
                  Send to anyone — fedi handle (user@domain.tld) or Bluesky handle (name.bsky.social).
                </p>
                <div className="flex gap-2">
                  <select
                    value={otherSource}
                    onChange={(e) => setOtherSource(e.target.value as "fedi" | "bsky")}
                    className="bg-surface-800 border border-surface-700 rounded-lg px-2 py-2 text-xs text-white"
                  >
                    <option value="fedi">Fedi</option>
                    <option value="bsky">Bluesky</option>
                  </select>
                  <input
                    type="text"
                    value={otherHandle}
                    onChange={(e) => setOtherHandle(e.target.value)}
                    placeholder={otherSource === "fedi" ? "user@domain.tld" : "name.bsky.social"}
                    className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600"
                  />
                  <button onClick={pickOther} className="btn-primary text-xs">Continue</button>
                </div>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or handle..."
                  className="w-full mb-3 bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600"
                />
                <div className="overflow-y-auto flex-1 space-y-1">
                  {filtered.length === 0 ? (
                    <p className="text-xs text-gray-600 text-center py-6">No matches</p>
                  ) : (
                    filtered.map((p) => {
                      const handle = p.source === "fedi" ? `@${p.username}@${p.domain}` : p.handle;
                      return (
                        <button
                          key={`${p.source}-${p.id}`}
                          onClick={() => pickFromList(p)}
                          className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-surface-800 text-left"
                        >
                          {p.avatarUrl ? (
                            <img src={p.avatarUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-surface-700 flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-white truncate">
                              {p.displayName || handle}
                            </p>
                            <p className="text-[10px] text-gray-500 truncate">
                              {handle}
                              <span className={`ml-2 ${p.source === "bsky" ? "text-blue-400" : "text-accent-400"}`}>
                                {p.source === "bsky" ? "bsky" : "fedi"}
                              </span>
                            </p>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3 pb-3 border-b border-surface-700">
              {recipient.avatar ? (
                <img src={recipient.avatar} alt="" className="w-10 h-10 rounded-full" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-surface-700" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">
                  {recipient.name || recipient.handle}
                </p>
                <p className="text-xs text-gray-500">
                  {recipient.handle}
                  <span className={`ml-2 ${recipient.source === "bsky" ? "text-blue-400" : "text-accent-400"}`}>
                    via {recipient.source === "bsky" ? "Bluesky" : "Fediverse"}
                  </span>
                </p>
              </div>
              <button
                onClick={() => setRecipient(null)}
                className="text-[11px] text-gray-500 hover:text-accent-400"
              >
                Change
              </button>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write your message..."
              rows={5}
              className="w-full bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none resize-none"
            />
            {error && (
              <p className="mt-2 text-xs text-red-400">{error}</p>
            )}
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={onClose} className="text-xs text-gray-500 hover:text-white px-3 py-2">
                Cancel
              </button>
              <button
                onClick={send}
                disabled={sending || !content.trim()}
                className="btn-primary text-xs disabled:opacity-50"
              >
                {sending ? "Sending..." : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MessagesTab({
  directMessages,
  readState,
  onMarkRead,
  onMarkAllRead,
  following,
  followers,
}: {
  directMessages: DirectMessageItem[];
  readState: Record<string, string>;
  onMarkRead: (key: string) => void;
  onMarkAllRead: () => void;
  following: FollowingItem[];
  followers: FollowerItem[];
}) {
  const [activeConvo, setActiveConvo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [sending, setSending] = useState(false);
  const [pollingBsky, setPollingBsky] = useState(false);
  const [popupConvoKey, setPopupConvoKey] = useState<string | null>(null);
  const [showThreadUserPopup, setShowThreadUserPopup] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  // Auto-mark conversation as read when opened
  useEffect(() => {
    if (activeConvo) {
      onMarkRead(activeConvo);
    }
    // onMarkRead is stable enough for our purposes; including it would re-fire
    // every parent render and double-mark. We only care about activeConvo changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvo]);

  const conversations: Conversation[] = buildConversations(directMessages, readState);

  const activeConversation = conversations.find((c) => c.key === activeConvo);

  const handleReply = async () => {
    if (!replyContent.trim() || !activeConversation || sending) return;
    setSending(true);

    const action =
      activeConversation.source === "bluesky" ? "bsky_dm_reply" : "dm_reply";

    const body: Record<string, string> =
      activeConversation.source === "bluesky"
        ? { action, content: replyContent.trim(), convoId: activeConversation.bskyConvoId || "" }
        : { action, content: replyContent.trim(), recipientUri: activeConversation.senderUri };

    try {
      await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setReplyContent("");
      // Reload to see sent message
      window.location.reload();
    } catch {
      // silently fail
    }
    setSending(false);
  };

  const handlePollBluesky = async () => {
    setPollingBsky(true);
    try {
      await fetch("/api/bluesky-dms");
      window.location.reload();
    } catch {
      // silently fail
    }
    setPollingBsky(false);
  };

  if (activeConversation) {
    // Thread view
    return (
      <div>
        <button
          onClick={() => { setActiveConvo(null); setShowThreadUserPopup(false); }}
          className="text-xs text-gray-500 hover:text-accent-400 mb-4 flex items-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to conversations
        </button>

        <div className="glass-card p-4 mb-4">
          <div className="flex items-center gap-3 relative">
            {activeConversation.avatar ? (
              <img src={activeConversation.avatar} alt="" className="w-10 h-10 rounded-full" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-surface-700" />
            )}
            <div>
              <button
                onClick={() => setShowThreadUserPopup(!showThreadUserPopup)}
                className="text-sm font-semibold text-white hover:text-accent-400 transition-colors text-left"
              >
                {activeConversation.name || activeConversation.handle}
              </button>
              <p className="text-xs text-gray-600">
                <button
                  onClick={() => setShowThreadUserPopup(!showThreadUserPopup)}
                  className="hover:text-accent-400 transition-colors"
                >
                  {activeConversation.handle}
                </button>
                <span className={`ml-2 ${activeConversation.source === "bluesky" ? "text-blue-400" : "text-accent-400"}`}>
                  via {activeConversation.source === "bluesky" ? "Bluesky" : "Fediverse"}
                </span>
              </p>
            </div>
            {showThreadUserPopup && (
              <UserProfilePopup
                name={activeConversation.name}
                handle={activeConversation.handle}
                avatar={activeConversation.avatar}
                actorUri={activeConversation.senderUri}
                source={activeConversation.source as "fedi" | "bluesky"}
                onClose={() => setShowThreadUserPopup(false)}
              />
            )}
          </div>
        </div>

        <div className="space-y-3 mb-4 max-h-[60vh] overflow-y-auto">
          {activeConversation.messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.isOutgoing ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[75%] rounded-lg p-3 ${
                  msg.isOutgoing
                    ? "bg-accent-400/10 border border-accent-400/20"
                    : "bg-surface-800 border border-surface-700"
                }`}
              >
                {msg.contentHtml && !msg.isOutgoing ? (
                  <div
                    className="text-sm text-gray-300 [&_a]:text-accent-400 [&_a]:hover:underline"
                    dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
                  />
                ) : (
                  <p className="text-sm text-gray-300">{msg.content}</p>
                )}
                <p className="text-[10px] text-gray-600 mt-1 flex items-center gap-1">
                  <span>{new Date(msg.createdAt).toLocaleString()}</span>
                  {msg.isOutgoing && (
                    msg.deliveredAt ? (
                      <span title={`Delivered ${new Date(msg.deliveredAt).toLocaleString()}`} className="text-green-500">✓</span>
                    ) : msg.deliveryError ? (
                      <span title={`Delivery failed: ${msg.deliveryError}`} className="text-red-400">✗</span>
                    ) : (
                      <span title="Delivery status unknown (sent before tracking added, or still pending)" className="text-gray-600">·</span>
                    )
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Reply input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleReply(); }}
            placeholder="Write a reply..."
            className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none"
          />
          <button
            onClick={handleReply}
            disabled={sending || !replyContent.trim()}
            className="btn-primary text-xs disabled:opacity-50"
          >
            {sending ? "..." : "Send"}
          </button>
        </div>
      </div>
    );
  }

  const anyUnread = conversations.some((c) => c.hasUnread);

  const handleMarkAllRead = async () => {
    if (markingAll || !anyUnread) return;
    setMarkingAll(true);
    await onMarkAllRead();
    setMarkingAll(false);
  };

  // Conversation list view
  return (
    <div>
      {showCompose && (
        <NewMessageModal
          following={following}
          followers={followers}
          onClose={() => setShowCompose(false)}
        />
      )}

      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <p className="text-xs text-gray-500">{conversations.length} conversations</p>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => setShowCompose(true)}
            className="text-xs text-accent-400 hover:text-accent-300 transition-colors"
          >
            + New message
          </button>
          <button
            onClick={handleMarkAllRead}
            disabled={markingAll || !anyUnread}
            className="text-xs text-gray-400 hover:text-accent-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {markingAll ? "Marking..." : "Mark all read"}
          </button>
          <button
            onClick={handlePollBluesky}
            disabled={pollingBsky}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-50"
          >
            {pollingBsky ? "Checking..." : "Check Bluesky DMs"}
          </button>
        </div>
      </div>

      {conversations.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-gray-500">No messages yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {conversations.map((convo) => (
            <div
              key={convo.key}
              onClick={() => setActiveConvo(convo.key)}
              className="glass-card p-4 w-full text-left flex items-center gap-3 hover:border-accent-400/20 transition-colors cursor-pointer"
            >
              {convo.avatar ? (
                <img src={convo.avatar} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-surface-700 flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0 relative">
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setPopupConvoKey(popupConvoKey === convo.key ? null : convo.key);
                    }}
                    className="text-sm font-semibold text-white truncate hover:text-accent-400 transition-colors"
                  >
                    {convo.name || convo.handle}
                  </button>
                  <span className={`text-[10px] ${convo.source === "bluesky" ? "text-blue-400" : "text-accent-400"}`}>
                    {convo.source === "bluesky" ? "bsky" : "fedi"}
                  </span>
                  {convo.hasUnread && (
                    <>
                      <span className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onMarkRead(convo.key);
                        }}
                        className="text-[10px] text-gray-500 hover:text-accent-400 transition-colors"
                      >
                        Mark read
                      </button>
                    </>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate">
                  {convo.lastMessage.isOutgoing ? "You: " : ""}
                  {convo.lastMessage.content.slice(0, 80)}
                </p>
                {popupConvoKey === convo.key && (
                  <UserProfilePopup
                    name={convo.name}
                    handle={convo.handle}
                    avatar={convo.avatar}
                    actorUri={convo.senderUri}
                    source={convo.source as "fedi" | "bluesky"}
                    onClose={() => setPopupConvoKey(null)}
                  />
                )}
              </div>
              <p className="text-[10px] text-gray-600 flex-shrink-0">
                {new Date(convo.lastMessage.createdAt).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TimelineClient({
  initialPosts,
  initialCursor,
  following,
  followers,
  pendingComments,
  directMessages = [],
  dmReadState: initialDmReadState = {},
  analyticsData,
  fediAddress,
}: {
  initialPosts: FediPostItem[];
  initialCursor: string | null;
  followers: FollowerItem[];
  following: FollowingItem[];
  pendingComments: PendingComment[];
  directMessages?: DirectMessageItem[];
  dmReadState?: Record<string, string>;
  analyticsData?: AnalyticsData | null;
  fediAddress: string;
}) {
  const [tab, setTab] = useState<"feed" | "replies" | "moderation" | "followers" | "following" | "messages" | "analytics">("feed");
  const [showReplies, setShowReplies] = useState(false);
  const [showBoosts, setShowBoosts] = useState(false);
  const [posts, setPosts] = useState<FediPostItem[]>(initialPosts);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [replyTo, setReplyTo] = useState<{ apId: string; inbox: string } | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [followHandle, setFollowHandle] = useState("");
  const [threadPosts, setThreadPosts] = useState<FediPostItem[] | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);

  // On-demand interaction counts cache (post.id → counts). Mirrors what's in
  // the DB for the lifetime of the page and is updated optimistically.
  const [postCounts, setPostCounts] = useState<Map<string, FediCountsState>>(new Map());

  const handleLoadCounts = useCallback(async (postId: string) => {
    setPostCounts((prev) => {
      const existing = prev.get(postId);
      if (existing?.loading) return prev;
      const next = new Map(prev);
      next.set(postId, {
        likeCount: existing?.likeCount ?? null,
        boostCount: existing?.boostCount ?? null,
        replyCount: existing?.replyCount ?? null,
        countsFetchedAt: existing?.countsFetchedAt ?? null,
        loading: true,
      });
      return next;
    });
    try {
      const res = await fetch("/api/fedi-post-counts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId }),
      });
      if (res.ok) {
        const data = (await res.json()) as Omit<FediCountsState, "loading">;
        setPostCounts((prev) => {
          const next = new Map(prev);
          next.set(postId, { ...data, loading: false });
          return next;
        });
      } else {
        setPostCounts((prev) => {
          const next = new Map(prev);
          const existing = next.get(postId);
          next.set(postId, { ...(existing ?? { likeCount: null, boostCount: null, replyCount: null, countsFetchedAt: null }), loading: false });
          return next;
        });
      }
    } catch {
      setPostCounts((prev) => {
        const next = new Map(prev);
        const existing = next.get(postId);
        next.set(postId, { ...(existing ?? { likeCount: null, boostCount: null, replyCount: null, countsFetchedAt: null }), loading: false });
        return next;
      });
    }
  }, []);

  // Replies tab state
  const [replies, setReplies] = useState<ReplyItem[] | null>(null);
  const [repliesCursor, setRepliesCursor] = useState<string | null>(null);
  const [repliesLoading, setRepliesLoading] = useState(false);

  const loadReplies = useCallback(async (cursor?: string | null) => {
    setRepliesLoading(true);
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/replies?${params}`);
      if (res.ok) {
        const data = await res.json();
        setReplies((prev) => (cursor && prev ? [...prev, ...data.replies] : data.replies));
        setRepliesCursor(data.nextCursor);
      }
    } catch {
      // silently fail
    }
    setRepliesLoading(false);
  }, []);

  // Server-backed DM read state. Initial values come from props (DmConversationRead
  // table); we mutate optimistically and POST to /api/admin in the background.
  const [dmReadState, setDmReadState] = useState<Record<string, string>>(initialDmReadState);

  const handleMarkDmRead = useCallback(async (conversationKey: string) => {
    const now = new Date().toISOString();
    setDmReadState((prev) =>
      prev[conversationKey] === now ? prev : { ...prev, [conversationKey]: now }
    );
    try {
      await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_dm_read", conversationKey }),
      });
    } catch {
      // Optimistic update already applied; transient failures are non-fatal.
    }
  }, []);

  const handleMarkAllDmsRead = useCallback(async () => {
    const now = new Date().toISOString();
    const allKeys = Array.from(new Set(directMessages.map((m) => m.conversationKey)));
    setDmReadState((prev) => {
      const next = { ...prev };
      for (const key of allKeys) next[key] = now;
      return next;
    });
    try {
      await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_all_dms_read" }),
      });
    } catch {
      // see above
    }
  }, [directMessages]);

  // Filter feed based on toggles
  const feedPosts = posts.filter((p) => {
    if (!showReplies && p.inReplyTo) return false;
    if (!showBoosts && p.boostedBy) return false;
    return true;
  });

  const buildFeedParams = (extra?: Record<string, string>) => {
    const params = new URLSearchParams(extra);
    if (showReplies) params.set("replies", "1");
    if (showBoosts) params.set("boosts", "1");
    return params;
  };

  const handleLoadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = buildFeedParams({ cursor });
      const res = await fetch(`/api/feed?${params}`);
      if (res.ok) {
        const data = await res.json();
        setPosts((prev) => [...prev, ...data.posts]);
        setCursor(data.nextCursor);
      }
    } catch {
      // silently fail
    }
    setLoadingMore(false);
  };

  // Reset pagination when toggling filters
  const refetchFeed = async (replies: boolean, boosts: boolean) => {
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (replies) params.set("replies", "1");
      if (boosts) params.set("boosts", "1");
      const res = await fetch(`/api/feed?${params}`);
      if (res.ok) {
        const data = await res.json();
        setPosts(data.posts);
        setCursor(data.nextCursor);
      }
    } catch {
      // silently fail
    }
    setLoadingMore(false);
  };

  const handleToggleReplies = () => {
    const next = !showReplies;
    setShowReplies(next);
    refetchFeed(next, showBoosts);
  };

  const handleToggleBoosts = () => {
    const next = !showBoosts;
    setShowBoosts(next);
    refetchFeed(showReplies, next);
  };

  const handleViewThread = async (postId: string) => {
    setThreadLoading(true);
    try {
      const res = await fetch(`/api/conversation?postId=${postId}`);
      if (res.ok) {
        const data = await res.json();
        setThreadPosts(data.thread);
      }
    } catch {
      // silently fail
    }
    setThreadLoading(false);
  };

  // Lazy-load replies the first time the tab is opened.
  useEffect(() => {
    if (tab === "replies" && replies === null && !repliesLoading) {
      loadReplies();
    }
  }, [tab, replies, repliesLoading, loadReplies]);

  return (
    <div>
      {/* Thread overlay */}
      {threadPosts && (
        <ThreadView
          thread={threadPosts}
          onClose={() => setThreadPosts(null)}
          counts={postCounts}
          onLoadCounts={handleLoadCounts}
        />
      )}
      {threadLoading && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
          <div className="text-accent-400 text-sm">Loading thread...</div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(["feed", "replies", "messages", "moderation", "followers", "following", "analytics"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-lg border transition-colors ${
              tab === t
                ? "border-accent-400/30 bg-accent-400/10 text-accent-400"
                : "border-surface-700 text-gray-500 hover:text-gray-300"
            }`}
          >
            {t}
            {t === "moderation" && pendingComments.length > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                {pendingComments.length}
              </span>
            )}
            {t === "messages" && (() => {
              const unreadCount = buildConversations(directMessages, dmReadState).filter(
                (c) => c.hasUnread
              ).length;
              return unreadCount > 0 ? (
                <span className="ml-1.5 bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                  {unreadCount}
                </span>
              ) : null;
            })()}
          </button>
        ))}
      </div>

      {/* Feed */}
      {tab === "feed" && (
        <div>
          {/* Feed toggles */}
          <div className="flex items-center gap-4 mb-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <button
                onClick={handleToggleReplies}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  showReplies ? "bg-accent-400" : "bg-surface-600"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    showReplies ? "translate-x-4" : ""
                  }`}
                />
              </button>
              <span className="text-xs text-gray-500">Show replies</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <button
                onClick={handleToggleBoosts}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  showBoosts ? "bg-accent-400" : "bg-surface-600"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    showBoosts ? "translate-x-4" : ""
                  }`}
                />
              </button>
              <span className="text-xs text-gray-500">Show boosts</span>
            </label>
          </div>

          <div className="space-y-4">
            {feedPosts.length === 0 ? (
              <div className="glass-card p-8 text-center">
                <p className="text-gray-500">
                  {showReplies
                    ? "Your feed is empty. Follow some accounts to see their posts here."
                    : "No top-level posts. Try toggling replies on, or follow more accounts."}
                </p>
              </div>
            ) : (
              feedPosts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  replyTo={replyTo}
                  setReplyTo={setReplyTo}
                  replyContent={replyContent}
                  setReplyContent={setReplyContent}
                  allPosts={posts}
                  onViewThread={handleViewThread}
                  counts={postCounts.get(post.id)}
                  onLoadCounts={handleLoadCounts}
                />
              ))
            )}

            {/* Load more */}
            {cursor && (
              <div className="text-center pt-2">
                <button
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="px-6 py-2 text-sm text-accent-400 border border-accent-400/30 rounded-lg hover:bg-accent-400/10 transition-colors disabled:opacity-50"
                >
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              </div>
            )}

            {!cursor && feedPosts.length > 0 && (
              <p className="text-center text-xs text-gray-600 pt-2">
                You've reached the end
              </p>
            )}
          </div>
        </div>
      )}

      {/* Replies — outgoing replies I've made to other people's posts */}
      {tab === "replies" && (
        <RepliesTab
          replies={replies}
          loading={repliesLoading}
          cursor={repliesCursor}
          onLoadMore={() => loadReplies(repliesCursor)}
          onViewThread={(postId) => {
            handleViewThread(postId);
            if (!postCounts.get(postId)?.countsFetchedAt) {
              handleLoadCounts(postId);
            }
          }}
        />
      )}

      {/* Messages */}
      {tab === "messages" && (
        <MessagesTab
          directMessages={directMessages}
          readState={dmReadState}
          onMarkRead={handleMarkDmRead}
          onMarkAllRead={handleMarkAllDmsRead}
          following={following}
          followers={followers}
        />
      )}

      {/* Moderation */}
      {tab === "moderation" && (
        <div className="space-y-4">
          {pendingComments.length === 0 ? (
            <div className="glass-card p-8 text-center">
              <p className="text-gray-500">No pending comments to moderate.</p>
            </div>
          ) : (
            pendingComments.map((comment) => (
              <div key={comment.id} className="glass-card p-5">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full bg-surface-700 flex items-center justify-center text-xs text-gray-400">
                    {comment.guestName[0]?.toUpperCase()}
                  </div>
                  <span className="text-sm font-semibold text-white">
                    {comment.guestName}
                  </span>
                  <span className="text-xs text-gray-600">
                    on{" "}
                    {comment.post
                      ? comment.post.title || comment.post.slug
                      : comment.photo
                        ? comment.photo.title || comment.photo.slug
                        : "unknown"}
                  </span>
                </div>
                <p className="text-gray-400 text-sm mb-3">{comment.content}</p>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      await fetch("/api/admin", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "approve_comment",
                          commentId: comment.id,
                        }),
                      });
                      window.location.reload();
                    }}
                    className="btn-primary text-xs !py-1.5"
                  >
                    Approve
                  </button>
                  <button
                    onClick={async () => {
                      await fetch("/api/admin", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "reject_comment",
                          commentId: comment.id,
                        }),
                      });
                      window.location.reload();
                    }}
                    className="text-red-400 hover:text-red-300 text-xs border border-red-800 px-3 py-1.5 rounded-lg"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Followers */}
      {tab === "followers" && (
        <div className="space-y-2">
          <div className="flex justify-end mb-2">
            <button
              onClick={async () => {
                await fetch("/api/admin", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "sync_bluesky_graph" }),
                });
                window.location.reload();
              }}
              className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800/50 px-3 py-1.5 rounded-lg"
            >
              Sync Bluesky
            </button>
          </div>
          {followers.length === 0 ? (
            <div className="glass-card p-8 text-center">
              <p className="text-gray-500">No followers yet. Share your Fedi handle <span className="text-accent-400 font-mono">{fediAddress}</span> to get discovered.</p>
            </div>
          ) : (
            followers.map((f) => {
              const profileUrl = f.source === "fedi" ? f.actorUri : `https://bsky.app/profile/${f.handle}`;
              const handleLabel = f.source === "fedi" ? `@${f.username}@${f.domain}` : `@${f.handle}`;
              const fallbackName = f.source === "fedi" ? f.username : f.handle;
              const isFollowing = f.source === "fedi"
                ? following.some((fw) => fw.source === "fedi" && fw.actorUri === f.actorUri)
                : following.some((fw) => fw.source === "bsky" && fw.did === f.did);
              return (
                <div key={`${f.source}:${f.id}`} className="glass-card p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {f.avatarUrl ? (
                      <img src={f.avatarUrl} alt="" className="w-10 h-10 rounded-full" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-surface-700" />
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-white">{f.displayName || fallbackName}</p>
                        {f.source === "bsky" && (
                          <span className="text-[10px] uppercase tracking-wide text-blue-400 border border-blue-800/60 px-1.5 py-0.5 rounded">bsky</span>
                        )}
                      </div>
                      <a
                        href={profileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-gray-500 hover:text-accent-400 transition-colors"
                      >
                        {handleLabel}
                      </a>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-gray-500 hover:text-accent-400 transition-colors"
                    >
                      View Profile
                    </a>
                    {!isFollowing && (
                      <button
                        onClick={async () => {
                          if (f.source === "fedi") {
                            await fetch("/api/admin", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                action: "follow",
                                handle: `@${f.username}@${f.domain}`,
                              }),
                            });
                          } else {
                            await fetch("/api/admin", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                action: "bsky_follow",
                                did: f.did,
                              }),
                            });
                          }
                          window.location.reload();
                        }}
                        className="btn-primary text-xs !py-1 !px-3"
                      >
                        Follow Back
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Following */}
      {tab === "following" && (
        <div>
          {/* Follow form */}
          <div className="glass-card p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-white">
                Follow an Account
              </h3>
              <button
                onClick={async () => {
                  await fetch("/api/admin", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "sync_bluesky_graph" }),
                  });
                  window.location.reload();
                }}
                className="text-xs text-blue-400 hover:text-blue-300 border border-blue-800/50 px-3 py-1.5 rounded-lg"
              >
                Sync Bluesky
              </button>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="@user@mastodon.social or name.bsky.social"
                value={followHandle}
                onChange={(e) => setFollowHandle(e.target.value)}
                className="flex-1 bg-surface-800 border border-surface-700 rounded-lg px-4 py-2 text-sm text-white placeholder-gray-600 focus:border-accent-400/30 focus:outline-none"
              />
              <button
                onClick={async () => {
                  const raw = followHandle.trim();
                  if (!raw) return;
                  const fediRe = /^@?[^@\s]+@[^@\s]+\.[^@\s]+$/;
                  const isFedi = fediRe.test(raw);
                  const payload = isFedi
                    ? { action: "follow", handle: raw }
                    : { action: "bsky_follow", handleOrDid: raw };
                  await fetch("/api/admin", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                  });
                  setFollowHandle("");
                  window.location.reload();
                }}
                className="btn-primary text-xs"
              >
                Follow
              </button>
            </div>
          </div>

          {/* Following list */}
          <div className="space-y-2">
            {following.length === 0 ? (
              <p className="text-gray-500 text-sm">
                Not following anyone yet.
              </p>
            ) : (
              following.map((f) => {
                const handleLabel = f.source === "fedi" ? `@${f.username}@${f.domain}` : `@${f.handle}`;
                const fallbackName = f.source === "fedi" ? f.username : f.handle;
                const profileUrl = f.source === "fedi" ? f.actorUri : `https://bsky.app/profile/${f.handle}`;
                const bskyNeedsSync = f.source === "bsky" && !f.followUri;
                return (
                  <div
                    key={`${f.source}:${f.id}`}
                    className="glass-card p-4 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      {f.avatarUrl ? (
                        <img
                          src={f.avatarUrl}
                          alt=""
                          className="w-8 h-8 rounded-full"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-surface-700" />
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-white">
                            {f.displayName || fallbackName}
                          </p>
                          {f.source === "bsky" && (
                            <span className="text-[10px] uppercase tracking-wide text-blue-400 border border-blue-800/60 px-1.5 py-0.5 rounded">bsky</span>
                          )}
                        </div>
                        <a
                          href={profileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-gray-600 hover:text-accent-400 transition-colors"
                        >
                          {handleLabel}
                        </a>
                      </div>
                    </div>
                    <button
                      disabled={bskyNeedsSync}
                      title={bskyNeedsSync ? "Sync Bluesky and retry" : undefined}
                      onClick={async () => {
                        const payload = f.source === "fedi"
                          ? { action: "unfollow", followingId: f.id }
                          : { action: "bsky_unfollow", followingId: f.id };
                        await fetch("/api/admin", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(payload),
                        });
                        window.location.reload();
                      }}
                      className="text-xs text-gray-500 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-500"
                    >
                      Unfollow
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {tab === "analytics" && (
        <div className="space-y-6">
          {analyticsData ? (
            <>
              {/* Overview cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="glass-card p-4 text-center">
                  <p className="text-2xl font-bold text-white">{analyticsData.stats?.totalHits?.toLocaleString() || 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Total Visits</p>
                </div>
                <div className="glass-card p-4 text-center">
                  <p className="text-2xl font-bold text-white">{analyticsData.stats?.totalKudos || 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Total Kudos</p>
                </div>
                <div className="glass-card p-4 text-center">
                  <p className="text-2xl font-bold text-white">{analyticsData.recentHits.length}</p>
                  <p className="text-xs text-gray-500 mt-1">Recent Hits</p>
                </div>
                <div className="glass-card p-4 text-center">
                  <p className="text-2xl font-bold text-white">{new Set(analyticsData.recentHits.map(h => h.path)).size}</p>
                  <p className="text-xs text-gray-500 mt-1">Unique Pages</p>
                </div>
              </div>

              {/* Top Pages */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Top Pages</h3>
                <div className="space-y-2">
                  {analyticsData.leaderboard.map((page, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <span className="text-xs text-gray-600 w-6 text-right font-mono">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm text-gray-300 truncate">{page.path}</span>
                          <span className="text-xs text-gray-500 ml-2 flex-shrink-0">{page.hits.toLocaleString()}</span>
                        </div>
                        <div className="w-full bg-surface-800 rounded-full h-1.5">
                          <div className="bg-accent-400/60 h-1.5 rounded-full" style={{ width: `${Math.min(page.percentage, 100)}%` }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Referrers + Countries row */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Referrers */}
                <div className="glass-card p-5">
                  <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Referrers</h3>
                  <div className="space-y-2">
                    {(() => {
                      const refs: Record<string, number> = {};
                      analyticsData.recentHits.forEach(h => {
                        const r = h.referrer ? (() => { try { return new URL(h.referrer).hostname.replace(/^www\./, ''); } catch { return h.referrer || 'Direct'; } })() : 'Direct';
                        refs[r] = (refs[r] || 0) + 1;
                      });
                      return Object.entries(refs)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10)
                        .map(([domain, count]) => (
                          <div key={domain} className="flex items-center justify-between text-sm">
                            <span className="text-gray-400 truncate">{domain}</span>
                            <span className="text-gray-500 text-xs font-mono ml-2">{count}</span>
                          </div>
                        ));
                    })()}
                  </div>
                </div>

                {/* Countries */}
                <div className="glass-card p-5">
                  <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Countries</h3>
                  <div className="space-y-2">
                    {(() => {
                      const countries: Record<string, number> = {};
                      analyticsData.recentHits.forEach(h => {
                        countries[h.country || 'Unknown'] = (countries[h.country || 'Unknown'] || 0) + 1;
                      });
                      return Object.entries(countries)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10)
                        .map(([code, count]) => (
                          <div key={code} className="flex items-center justify-between text-sm">
                            <span className="text-gray-400">{code}</span>
                            <span className="text-gray-500 text-xs font-mono">{count}</span>
                          </div>
                        ));
                    })()}
                  </div>
                </div>
              </div>

              {/* Recent Visitor Journeys */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Recent Visitor Journeys</h3>
                <div className="space-y-3">
                  {analyticsData.journeys.map((j, i) => (
                    <div key={i} className="p-3 bg-surface-800/50 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <span>{j.country}</span>
                          <span>·</span>
                          <span>{j.browser}</span>
                          <span>·</span>
                          <span>{j.session_duration}</span>
                        </div>
                        <span className="text-xs text-gray-600">{j.page_count} pages</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-gray-400 overflow-x-auto">
                        {j.pages.map((p, pi) => (
                          <span key={pi} className="flex items-center gap-1.5 flex-shrink-0">
                            {pi > 0 && <span className="text-gray-600">→</span>}
                            <span className="bg-surface-700 px-1.5 py-0.5 rounded">{p.path}</span>
                          </span>
                        ))}
                      </div>
                      {j.referrer && (
                        <p className="text-xs text-gray-600 mt-1">via {j.referrer}</p>
                      )}
                    </div>
                  ))}
                  {analyticsData.journeys.length === 0 && (
                    <p className="text-sm text-gray-500 text-center py-4">No visitor journeys recorded yet.</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* Setup prompt for unconfigured Tinylytics */
            <div className="glass-card p-8 text-center">
              <p className="text-3xl mb-4">📊</p>
              <h3 className="text-lg font-semibold text-white mb-2">Connect Tinylytics</h3>
              <p className="text-sm text-gray-400 mb-4 max-w-md mx-auto">
                Privacy-focused analytics for your site. No cookies, GDPR-compliant. See who visits your site, which pages are popular, and where your visitors come from.
              </p>
              <div className="text-left max-w-md mx-auto bg-surface-800 rounded-lg p-4 text-xs text-gray-400 font-mono mb-4">
                <p className="text-gray-500 mb-2"># Add to your .env.local:</p>
                <p>TINYLYTICS_API_KEY=tly-fa-your-key</p>
                <p>TINYLYTICS_SITE_ID=your-site-id</p>
              </div>
              <a
                href="https://tinylytics.app"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-outlined text-xs"
              >
                Get started at tinylytics.app →
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
