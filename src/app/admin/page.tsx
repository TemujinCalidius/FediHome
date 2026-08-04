export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyAdminSession } from "@/lib/auth";
import TimelineLogin from "../timeline/TimelineLogin";
import AdminHomeClient from "./AdminHomeClient";

/**
 * The owner area's home (#368).
 *
 * `/admin` returned 404 until now — the six pages under it existed with no index
 * above them, which is most of why the area was hard to navigate.
 *
 * `noindex` like the rest of the area: it is owner-only, and it is a map of
 * every administrative route on the instance.
 */
export const metadata = {
  title: "Your FediHome",
  description: "Everything you can change, in one place.",
  robots: { index: false, follow: false },
};

export default async function AdminHomePage() {
  const cookieStore = await cookies();
  if (!(await verifyAdminSession(cookieStore.get("sl_admin")?.value))) {
    return <TimelineLogin />;
  }

  // Settled, not awaited together: a count that fails should cost its own tile,
  // not the whole page. The home page failing to load is the worst possible
  // failure for the page whose job is being the way in.
  const [posts, followers, following, pendingComments] = await Promise.all([
    prisma.post.count({ where: { published: true } }).catch(() => 0),
    prisma.fediFollower.count().catch(() => 0),
    prisma.fediFollowing.count().catch(() => 0),
    prisma.guestComment.count({ where: { status: "pending" } }).catch(() => 0),
  ]);

  return <AdminHomeClient stats={{ posts, followers, following, pendingComments }} />;
}
