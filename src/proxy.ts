import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // --- Setup redirect ---
  // Skip for setup routes, API setup, and static assets
  const isSetupRoute = pathname === "/setup" || pathname.startsWith("/setup/");
  const isSetupApi = pathname === "/api/setup" || pathname.startsWith("/api/setup/");
  const isStaticAsset =
    pathname.startsWith("/_next") ||
    pathname.startsWith("/images") ||
    pathname.startsWith("/fonts") ||
    pathname.startsWith("/uploads") ||
    pathname === "/favicon.ico";

  if (!isSetupRoute && !isSetupApi && !isStaticAsset) {
    // Check if setup is done: either ADMIN_SECRET env var is set, or cookie exists
    const hasAdminSecret = !!process.env.ADMIN_SECRET;
    const hasSetupCookie = req.cookies.get("fedihome_setup")?.value === "done";

    if (!hasAdminSecret && !hasSetupCookie) {
      const url = req.nextUrl.clone();
      url.pathname = "/setup";
      return NextResponse.redirect(url);
    }
  }

  // --- Content negotiation for ActivityPub ---

  // Content negotiation for AP — rewrite /post/slug to AP JSON endpoint
  if (pathname.startsWith("/post/")) {
    const accept = req.headers.get("accept") || "";
    if (
      accept.includes("application/activity+json") ||
      accept.includes("application/ld+json")
    ) {
      const slug = pathname.slice("/post/".length);
      const url = req.nextUrl.clone();
      url.pathname = `/ap/post/${slug}`;
      return NextResponse.rewrite(url);
    }
  }

  // Content negotiation for /users/samuel — redirect AP requests to actor endpoint
  if (pathname.startsWith("/users/")) {
    const accept = req.headers.get("accept") || "";
    if (
      accept.includes("application/activity+json") ||
      accept.includes("application/ld+json")
    ) {
      const url = req.nextUrl.clone();
      url.pathname = "/ap/actor";
      return NextResponse.rewrite(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * We use a broad matcher so setup redirect works on all pages.
     */
    "/((?!_next/static|_next/image).*)",
  ],
};
