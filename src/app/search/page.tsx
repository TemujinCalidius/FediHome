export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { verifyAdminSession } from "@/lib/auth";
import TimelineLogin from "../timeline/TimelineLogin";
import SearchClient from "./SearchClient";

export const metadata = {
  title: "Search",
  description: "Search your posts and photos.",
};

export default async function SearchPage() {
  const cookieStore = await cookies();
  if (!(await verifyAdminSession(cookieStore.get("sl_admin")?.value))) {
    return <TimelineLogin />;
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-2">Search</h1>
      <p className="text-gray-500 text-sm mb-8">
        Find your posts and photos by title, text, or tag.
      </p>
      <SearchClient />
    </div>
  );
}
