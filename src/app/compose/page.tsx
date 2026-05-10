export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import ComposeClient from "./ComposeClient";
import TimelineLogin from "../timeline/TimelineLogin";

export const metadata = {
  title: "Compose",
  description: "Write a new post.",
};

export default async function ComposePage() {
  const cookieStore = await cookies();
  const adminToken = cookieStore.get("sl_admin")?.value;
  const { verifyAdminCookieValue } = await import("@/lib/auth");
  const isAdmin = verifyAdminCookieValue(adminToken);

  if (!isAdmin) {
    return <TimelineLogin />;
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="flex items-center justify-between mb-8">
        <h1 className="font-display text-3xl font-bold text-white">Compose</h1>
        <a
          href="/timeline"
          className="text-xs text-gray-500 hover:text-accent-400 transition-colors"
        >
          Back to Timeline
        </a>
      </div>
      <ComposeClient />
    </div>
  );
}
