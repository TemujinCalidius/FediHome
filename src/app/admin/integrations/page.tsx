export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { verifyAdminSession } from "@/lib/auth";
import { getIntegrationStatus } from "@/lib/integrations";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { getIdentity } from "@/lib/identity";
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
  // Read server-side rather than fetched on mount: this page is already a server
  // component doing the same work for status, and an effect that exists only to
  // populate state is what react-hooks/set-state-in-effect flags.
  const cfg = await getRuntimeSiteConfig();
  return (
    <IntegrationsClient
      initialStatus={await getIntegrationStatus()}
      initialDomainHandle={cfg.blueskyDomainHandle}
      fediDomain={getIdentity().fediDomain}
      encryptionAvailable={secretBoxAvailable()}
    />
  );
}
