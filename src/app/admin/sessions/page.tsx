export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyAdminSession, sessionIdFromCookie } from "@/lib/auth";
import TimelineLogin from "../../timeline/TimelineLogin";
import SessionsClient from "./SessionsClient";

export const metadata = {
  title: "Sessions",
  description: "Manage your signed-in admin sessions.",
};

export default async function AdminSessionsPage() {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get("sl_admin")?.value;

  if (!(await verifyAdminSession(cookieValue))) {
    return <TimelineLogin />;
  }

  const currentId = sessionIdFromCookie(cookieValue);
  const sessions = await prisma.adminSession.findMany({
    orderBy: { lastUsedAt: "desc" },
  });

  const rows = sessions.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    lastUsedAt: s.lastUsedAt.toISOString(),
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    userAgent: s.userAgent,
    current: s.id === currentId,
  }));

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-2">Sessions</h1>
      <p className="text-gray-500 text-sm mb-8">
        Devices currently signed in to your admin account. Revoke any you don&apos;t
        recognise — a revoked device is signed out the next time it makes a request.
      </p>
      <SessionsClient sessions={rows} />
    </div>
  );
}
