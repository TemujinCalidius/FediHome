interface Interaction {
  id: string;
  username: string;
  domain: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export default function FediInteractions({
  likes,
  boosts,
  replies,
  likeCount,
  boostCount,
  bskyLikeCount = 0,
  bskyRepostCount = 0,
  blueskyReplyCount = 0,
}: {
  likes: Interaction[];
  boosts: Interaction[];
  replies: Interaction[];
  likeCount: number;
  boostCount: number;
  bskyLikeCount?: number;
  bskyRepostCount?: number;
  blueskyReplyCount?: number;
}) {
  const totalLikes = likeCount + bskyLikeCount;
  const totalBoosts = boostCount + bskyRepostCount;
  const totalReplies = replies.length + blueskyReplyCount;

  if (totalLikes === 0 && totalBoosts === 0 && totalReplies === 0) return null;

  return (
    <div className="mt-8 pt-6 border-t border-surface-700">
      <div className="flex flex-wrap gap-4">
        {/* Likes */}
        {totalLikes > 0 && (
          <div className="flex items-center gap-2">
            <span className="fedi-badge">
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" />
              </svg>
              {totalLikes} {totalLikes === 1 ? "like" : "likes"}
            </span>
            {/* Breakdown if from multiple sources */}
            {likeCount > 0 && bskyLikeCount > 0 && (
              <span className="text-[10px] text-gray-600">
                ({likeCount} fedi, {bskyLikeCount} bsky)
              </span>
            )}
            {/* Show avatars of who liked (fedi only — Bluesky doesn't give us individual likers) */}
            <div className="flex -space-x-1">
              {likes.slice(0, 5).map((like) => (
                <div key={like.id} title={`@${like.username}@${like.domain}`}>
                  {like.avatarUrl ? (
                    <img
                      src={like.avatarUrl}
                      alt=""
                      className="w-5 h-5 rounded-full ring-1 ring-surface-950"
                    />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-surface-700 ring-1 ring-surface-950" />
                  )}
                </div>
              ))}
              {likes.length > 5 && (
                <div className="w-5 h-5 rounded-full bg-surface-700 ring-1 ring-surface-950 flex items-center justify-center text-[8px] text-gray-500">
                  +{likes.length - 5}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Boosts / Reposts */}
        {totalBoosts > 0 && (
          <div className="flex items-center gap-2">
            <span className="fedi-badge">
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
              </svg>
              {totalBoosts} {totalBoosts === 1 ? "repost" : "reposts"}
            </span>
            {boostCount > 0 && bskyRepostCount > 0 && (
              <span className="text-[10px] text-gray-600">
                ({boostCount} fedi, {bskyRepostCount} bsky)
              </span>
            )}
          </div>
        )}

        {/* Reply count */}
        {totalReplies > 0 && (
          <span className="fedi-badge">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
            </svg>
            {totalReplies} {totalReplies === 1 ? "reply" : "replies"}
          </span>
        )}
      </div>
    </div>
  );
}
