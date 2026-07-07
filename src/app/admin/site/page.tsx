export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyAdminSession } from "@/lib/auth";
import { siteConfigDefaults, getRuntimeSiteConfig, SITE_CONFIG_KEYS } from "@/lib/site-settings";
import TimelineLogin from "../../timeline/TimelineLogin";
import SiteSettingsClient from "./SiteSettingsClient";

export const metadata = {
  title: "Site settings",
  description: "Admin-editable site appearance & features.",
};

export default async function AdminSitePage() {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get("sl_admin")?.value;

  if (!(await verifyAdminSession(cookieValue))) {
    return <TimelineLogin />;
  }

  const rows = await prisma.siteSetting.findMany({ where: { key: { in: SITE_CONFIG_KEYS } } });

  return (
    <SiteSettingsClient
      defaults={siteConfigDefaults()}
      effective={await getRuntimeSiteConfig()}
      overrides={Object.fromEntries(rows.map((r) => [r.key, r.value]))}
    />
  );
}
