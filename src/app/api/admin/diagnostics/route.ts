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
  // Deliberately NOT wrapped in a try/catch that returns a partial bundle. The
  // final redaction pass (#490) is inside collectDiagnostics, and a bundle that
  // reached this point with that pass having thrown would be one whose log tail
  // was never checked against the saved credentials. No bundle beats a leaky one.
  let text: string;
  try {
    text = await collectDiagnostics();
  } catch (err) {
    console.error("diagnostics: refusing to emit an unredacted bundle:", err);
    return NextResponse.json(
      { error: "Couldn't build the bundle safely just now — nothing was produced. Try again." },
      { status: 500 },
    );
  }
  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Never cached anywhere: it is a point-in-time snapshot of one instance,
      // and a proxy holding it would be both wrong and unwelcome.
      "Cache-Control": "no-store, private",
    },
  });
}
