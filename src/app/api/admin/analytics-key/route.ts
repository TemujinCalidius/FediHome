import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import {
  getAnalyticsKeyStatus,
  setTinylyticsApiKey,
  clearTinylyticsApiKey,
} from "@/lib/analytics-secret";
import { secretBoxAvailable } from "@/lib/secret-box";

/**
 * Admin Tinylytics API key (#59): set/clear the analytics API key in-app instead
 * of editing `.env.local`. The key is stored AES-256-GCM-encrypted (secret-box,
 * key from ADMIN_SECRET) and is NEVER returned to the client — GET reports only a
 * configured/source status. Mirrors /api/admin/integrations.
 *
 * Cookie-only ON PURPOSE (`verifyAdmin`, no bearer path): the analytics key is an
 * owner-only secret; an app token must never read or set it — same stance as
 * /api/admin/integrations and /api/admin/site-config.
 */

const CONTROL = /[\r\n]/;

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    status: await getAnalyticsKeyStatus(),
    encryptionAvailable: secretBoxAvailable(),
  });
}

export async function POST(req: NextRequest) {
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));

  // Clear — remove the DB override (reverts to the env var if set).
  if (body?.clear === true) {
    await clearTinylyticsApiKey();
    return NextResponse.json({ success: true, status: await getAnalyticsKeyStatus() });
  }

  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey || apiKey.length > 500 || CONTROL.test(apiKey)) {
    return NextResponse.json({ error: "A valid API key is required." }, { status: 400 });
  }
  const r = await setTinylyticsApiKey(apiKey);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ success: true, status: await getAnalyticsKeyStatus() });
}
