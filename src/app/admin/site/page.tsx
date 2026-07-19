export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyAdminSession } from "@/lib/auth";
import { siteConfigDefaults, getRuntimeSiteConfig, SITE_CONFIG_KEYS } from "@/lib/site-settings";
import { getRuntimeProfile } from "@/lib/site-profile";
import { resolveTinylyticsEmbed } from "@/lib/tinylytics";
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

  const [rows, profile, effective] = await Promise.all([
    prisma.siteSetting.findMany({ where: { key: { in: SITE_CONFIG_KEYS } } }),
    getRuntimeProfile(),
    getRuntimeSiteConfig(),
  ]);

  // Resolve the collecting-embed code so the panel can confirm analytics is
  // actually collecting (vs configured-but-silently-404ing) (#288).
  const embedCode = await resolveTinylyticsEmbed(effective.analytics);
  const analyticsConfigured = !!(effective.analytics.siteId || effective.analytics.embedId);
  const analyticsStatus = {
    embedCode,
    // configured, but no valid embed code could be resolved → collecting nothing
    unresolved: analyticsConfigured && !embedCode,
  };

  return (
    <SiteSettingsClient
      defaults={siteConfigDefaults()}
      effective={effective}
      overrides={Object.fromEntries(rows.map((r) => [r.key, r.value]))}
      accent={{ accentColor: profile.accentColor, themeAccents: profile.themeAccents }}
      analyticsStatus={analyticsStatus}
    />
  );
}
