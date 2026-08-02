import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin } from "@/lib/auth";
import { collectDiagnostics } from "@/lib/diagnostics";

export const dynamic = "force-dynamic";

/**
 * The support bundle (#395). Admin-gated, read-only, and it never transmits
 * anything — the operator gets the text and decides what to do with it.
 *
 * GET rather than POST, and therefore no CSRF check: it writes nothing, and a
 * cross-site read cannot see the response body. Admin auth is still required, so
 * a stranger gets nothing either way.
 */
export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const text = await collectDiagnostics();
  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Never cached anywhere: it is a point-in-time snapshot of one instance,
      // and a proxy holding it would be both wrong and unwelcome.
      "Cache-Control": "no-store, private",
    },
  });
}
