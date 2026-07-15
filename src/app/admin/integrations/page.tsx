export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { verifyAdminSession } from "@/lib/auth";
import { getIntegrationStatus } from "@/lib/integrations";
import { secretBoxAvailable } from "@/lib/secret-box";
import TimelineLogin from "../../timeline/TimelineLogin";
import IntegrationsClient from "./IntegrationsClient";

export const metadata = {
  title: "Integrations",
  description: "Connect Bluesky and Threads for crossposting.",
};

export default async function AdminIntegrationsPage() {
  const cookieStore = await cookies();
  if (!(await verifyAdminSession(cookieStore.get("sl_admin")?.value))) {
    return <TimelineLogin />;
  }
  return (
    <IntegrationsClient
      initialStatus={await getIntegrationStatus()}
      encryptionAvailable={secretBoxAvailable()}
    />
  );
}
