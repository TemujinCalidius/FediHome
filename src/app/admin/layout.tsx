import { cookies } from "next/headers";
import { verifyAdminSession } from "@/lib/auth";
import AdminNav from "@/components/admin/AdminNav";

/**
 * Wraps every `/admin/*` page with the owner-area navigation (#368).
 *
 * A layout rather than an import in each of the six pages: one place to add a
 * seventh, and no page can ship without it. That was the actual failure — the
 * links existed in exactly one file, so the pages nobody linked to were
 * unreachable rather than merely hard to find.
 *
 * THE NAV IS GATED, THE PAGES ARE NOT GATED BY IT. Every page under here still
 * runs its own `verifyAdminSession` and still renders the login screen itself; a
 * layout is the wrong place to enforce auth, because a page that came to depend
 * on it would be unprotected the moment it moved. This check does one thing:
 * decides whether to draw the nav, so a signed-out visitor isn't handed a map of
 * routes they can't open.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const signedIn = await verifyAdminSession(cookieStore.get("sl_admin")?.value);

  return (
    <>
      {signedIn && <AdminNav />}
      {children}
    </>
  );
}
