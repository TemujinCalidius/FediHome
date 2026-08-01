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

  // The reverse gate: on a CONFIGURED instance the wizard is done — /setup
  // must not render (for anyone, admin included; re-configuration belongs to
  // the future admin backend, and an admin-authed wizard completion could
  // rewrite .env.local). The POST endpoint is separately locked, but the page
  // itself was reachable. /api/setup stays untouched: it has its own auth and
  // the no-ADMIN_SECRET recovery path needs it.
  if (isSetupRoute && process.env.ADMIN_SECRET) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
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

  // Content negotiation for /users/<handle> — AP requests get the actor document.
  //
  // The requested handle is carried through rather than compared here (#429).
  // Comparing in the proxy looks obvious and is a trap: identity overrides are
  // process-local, populated only by instrumentation's register() and never
  // re-read per request, so this module would see `process.env` alone. An
  // instance whose handle comes from the DB would then 404 its own actor — worse
  // than the bug being fixed. /ap/actor already reads the live identity, so it
  // is the honest place to decide.
  //
  // Exactly one segment: /users/<handle>/followers used to rewrite here too, and
  // the actor is the wrong document for it — collections live under /ap/*.
  if (pathname.startsWith("/users/")) {
    const accept = req.headers.get("accept") || "";
    const handle = pathname.slice("/users/".length);
    if (
      handle.length > 0 &&
      !handle.includes("/") &&
      (accept.includes("application/activity+json") ||
        accept.includes("application/ld+json"))
    ) {
      const url = req.nextUrl.clone();
      url.pathname = "/ap/actor";
      url.searchParams.set("handle", handle);
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
