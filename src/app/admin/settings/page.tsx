export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyAdminSession } from "@/lib/auth";
import { getSchedulerConfig, getEffectiveSchedulerConfig, SCHEDULER_SETTING_KEYS } from "@/lib/scheduler-config";
import TimelineLogin from "../../timeline/TimelineLogin";
import SettingsClient from "./SettingsClient";

export const metadata = {
  title: "Instance settings",
  description: "Admin-editable instance configuration.",
};

export default async function AdminSettingsPage() {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get("sl_admin")?.value;

  if (!(await verifyAdminSession(cookieValue))) {
    return <TimelineLogin />;
  }

  const rows = await prisma.siteSetting.findMany({
    where: { key: { in: [...SCHEDULER_SETTING_KEYS] } },
  });

  return (
    <SettingsClient
      defaults={getSchedulerConfig()}
      effective={await getEffectiveSchedulerConfig()}
      overrides={Object.fromEntries(rows.map((r) => [r.key, r.value]))}
    />
  );
}
