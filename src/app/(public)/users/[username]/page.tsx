import { notFound, redirect } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { prisma } from "@/lib/db";
import type { Metadata } from "next";
import { siteConfig } from "@/../site.config";
import { getRuntimeProfile } from "@/lib/site-profile";
import { getIdentity } from "@/lib/identity";
import { getMovedTo, moveHandle } from "@/lib/account-move";


export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}): Promise<Metadata> {
  const { username } = await params;
  if (username !== getIdentity().fediHandle) return { title: "Not Found" };
  const profile = await getRuntimeProfile();
  const desc = profile.authorBio || profile.authorTagline || "Follow me on the Fediverse.";
  return {
    title: `${profile.authorName} (@${getIdentity().fediHandle}@${getIdentity().fediDomain})`,
    description: desc,
    openGraph: {
      title: `${profile.authorName} (@${getIdentity().fediHandle}@${getIdentity().fediDomain})`,
      description: desc,
      images: [{ url: profile.avatarPath, width: 400, height: 400 }],
    },
  };
}

export default async function UserProfilePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  if (username !== getIdentity().fediHandle) notFound();

  const [postCount, followerCount, followingCount, profile, movedTo] = await Promise.all([
    prisma.post.count({ where: { inReplyToPostId: null } }),
    prisma.fediFollower.count(),
    prisma.fediFollowing.count(),
    getRuntimeProfile(),
    // Where this account went, if it left (#347). The actor document carries the
    // machine-readable half; this is the half a PERSON reads, and it matters
    // because a visitor who arrives from a bookmark or a search result gets no
    // ActivityPub anything — they just see a profile that has stopped.
    getMovedTo(),
  ]);

  return (
    <div className="max-w-2xl mx-auto px-4 py-12 md:py-20">
      <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
        {/* Header */}
        <div className="h-32 bg-gradient-to-r from-blue-600 to-indigo-700" />

        {/* Avatar + Info */}
        <div className="px-6 pb-6">
          <div className="-mt-16 mb-4">
            <Image
              src={profile.avatarPath}
              alt={profile.authorName}
              width={120}
              height={120}
              className="rounded-full border-4 border-white dark:border-neutral-900"
            />
          </div>

          {movedTo && (
            <div className="mb-4 rounded-lg border border-amber-400/40 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200 m-0">
                This account has moved
              </p>
              <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-100/90 m-0">
                {profile.authorName} is now at{" "}
                <a href={movedTo} rel="me noopener" className="font-medium underline">
                  {moveHandle(movedTo)}
                </a>
                . Follow them there — if you already follow this account, your server
                should move the follow across on its own.
              </p>
            </div>
          )}

          <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">
            {profile.authorName}
          </h1>
          <p className="text-neutral-500 dark:text-neutral-400 text-sm">
            @{getIdentity().fediHandle}@{getIdentity().fediDomain}
          </p>

          <p className="mt-3 text-neutral-700 dark:text-neutral-300 text-sm leading-relaxed">
            {profile.authorBio || profile.authorTagline || siteConfig.description}
          </p>

          {/* Stats */}
          <div className="flex gap-6 mt-4 text-sm">
            <div>
              <span className="font-bold text-neutral-900 dark:text-white">{postCount}</span>
              <span className="text-neutral-500 dark:text-neutral-400 ml-1">posts</span>
            </div>
            <div>
              <span className="font-bold text-neutral-900 dark:text-white">{followerCount}</span>
              <span className="text-neutral-500 dark:text-neutral-400 ml-1">followers</span>
            </div>
            <div>
              <span className="font-bold text-neutral-900 dark:text-white">{followingCount}</span>
              <span className="text-neutral-500 dark:text-neutral-400 ml-1">following</span>
            </div>
          </div>

          {/* Links */}
          <div className="flex gap-3 mt-6">
            <Link
              href="/"
              className="px-4 py-2 text-sm font-medium rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
            >
              Website
            </Link>
            <Link
              href="/photography"
              className="px-4 py-2 text-sm font-medium rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
            >
              Photography
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
