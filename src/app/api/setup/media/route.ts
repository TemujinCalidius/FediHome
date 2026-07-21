import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin } from "@/lib/auth";
import { verifySetupToken } from "@/lib/setup-token";
import { saveUploadedImage } from "@/lib/media";

/**
 * First-run image upload for the setup wizard (#59) — avatar/banner, before an
 * owner cookie exists. Gated exactly like /api/setup: once `ADMIN_SECRET` is set
 * (setup complete or an install.sh deploy) it requires admin auth; on a fresh
 * deploy it requires the out-of-band setup token (header `x-setup-token`). Images
 * only, re-encoded (EXIF-stripped) by the shared pipeline, written to
 * public/uploads. Returns the RELATIVE path the wizard then submits to /api/setup.
 */
export async function POST(req: NextRequest) {
  if (process.env.ADMIN_SECRET) {
    if (!(await verifyAdmin(req))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (!(await verifySetupToken(req.headers.get("x-setup-token")))) {
    return NextResponse.json({ error: "setup token required" }, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file uploaded" }, { status: 400 });
  }

  const result = await saveUploadedImage(file);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ path: result.path }, { status: 201 });
}
