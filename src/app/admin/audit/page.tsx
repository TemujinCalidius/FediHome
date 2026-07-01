export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyAdminSession } from "@/lib/auth";
import TimelineLogin from "../../timeline/TimelineLogin";

export const metadata = {
  title: "App activity",
  description: "Recent connected-app API activity.",
};

function fmtUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export default async function AdminAuditPage() {
  const cookieStore = await cookies();
  if (!(await verifyAdminSession(cookieStore.get("sl_admin")?.value))) {
    return <TimelineLogin />;
  }

  const rows = await prisma.appTokenUsage.findMany({ orderBy: { at: "desc" }, take: 100 });

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-2">App activity</h1>
      <p className="text-gray-500 text-sm mb-8">
        Write actions made by connected apps (read requests aren&apos;t logged). Kept for 30 days.
      </p>
      {rows.length === 0 ? (
        <p className="text-gray-500 text-sm">No app activity yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="glass-card p-3 flex items-center justify-between gap-4 text-sm"
            >
              <div className="min-w-0">
                <span className="text-white font-medium">{r.label}</span>
                <span className="text-gray-500">
                  {" "}
                  · {r.method} {r.path}
                </span>
              </div>
              <span className="text-xs text-gray-600 whitespace-nowrap">{fmtUtc(r.at.toISOString())}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
