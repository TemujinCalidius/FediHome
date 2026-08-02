import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin } from "@/lib/auth";
import { exportStream } from "@/lib/export";
import { getIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";
// Node, not Edge: the export streams from Prisma, and it can legitimately run
// for minutes on a large instance.
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Content export (#365). Admin-gated, streamed, never buffered.
 *
 * GET so it can be a plain download link — it writes nothing, and a cross-site
 * read cannot see the body. Admin auth is still required.
 */
export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let version = "unknown";
  try {
    const pkg = await import("../../../../../package.json");
    version =
      (pkg as { version?: string }).version ??
      (pkg as { default?: { version?: string } }).default?.version ??
      "unknown";
  } catch {
    /* reported as unknown */
  }

  const id = getIdentity();
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(
    exportStream({ siteUrl: id.siteUrl, fediAddress: `@${id.fediHandle}@${id.fediDomain}`, version }),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="fedihome-export-${stamp}.ndjson"`,
        // No length header — it is streamed and the size is not known up front.
        "Cache-Control": "no-store, private",
      },
    },
  );
}
