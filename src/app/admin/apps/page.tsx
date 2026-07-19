export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyAdminSession } from "@/lib/auth";
import { siteConfig } from "@/../site.config";
import TimelineLogin from "../../timeline/TimelineLogin";
import AppsClient from "./AppsClient";

export const metadata = {
  title: "Connected apps",
  description: "Apps and tokens that can access your instance.",
};

export default async function AdminAppsPage() {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get("sl_admin")?.value;

  if (!(await verifyAdminSession(cookieValue))) {
    return <TimelineLogin />;
  }

  const tokens = await prisma.authToken.findMany({ orderBy: { createdAt: "desc" } });

  const rows = tokens.map((t) => ({
    id: t.id,
    label: t.label,
    scope: t.scope,
    clientId: t.clientId,
    createdVia: t.createdVia,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
  }));

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-white mb-2">Connected apps</h1>
      <p className="text-gray-500 text-sm mb-8">
        Apps and tokens that can access your instance with a bearer token — native
        apps you signed in via OAuth, plus any Micropub tokens. Revoke anything you
        don&apos;t recognise; a revoked token stops working on its next request.
      </p>
      <AppsClient tokens={rows} instanceUrl={siteConfig.url} />
    </div>
  );
}
