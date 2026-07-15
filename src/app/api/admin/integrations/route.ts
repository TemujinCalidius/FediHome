import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import {
  getIntegrationStatus,
  setBlueskyCredentials,
  clearBlueskyCredentials,
  testBlueskyLogin,
  setThreadsCredentials,
  clearThreadsCredentials,
  testThreadsToken,
} from "@/lib/integrations";
import { secretBoxAvailable } from "@/lib/secret-box";

/**
 * Admin crosspost integrations (#59): configure Bluesky + Threads credentials
 * in-app instead of editing `.env.local`. Secrets are stored AES-256-GCM-
 * encrypted (secret-box, key from ADMIN_SECRET) and are NEVER returned to the
 * client — GET reports only a configured/handle/source status.
 *
 * Cookie-only ON PURPOSE (`verifyAdmin`, no bearer path): these are owner-only
 * credentials, an app token must never read or reconfigure them — same stance
 * as /api/admin/settings and /api/admin/site-config.
 *
 * `save` tests the connection FIRST and refuses to store a credential that
 * doesn't authenticate, so a wrong password can't be silently persisted.
 */

const CONTROL = /[\r\n]/;
function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max || CONTROL.test(t)) return null;
  return t;
}

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    status: await getIntegrationStatus(),
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
  const action = body?.action;
  const provider = body?.provider;
  if (provider !== "bluesky" && provider !== "threads") {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }

  // Disconnect — clear the DB override (reverts to the env var if set).
  if (action === "disconnect") {
    if (provider === "bluesky") await clearBlueskyCredentials();
    else await clearThreadsCredentials();
    return NextResponse.json({ success: true, status: await getIntegrationStatus() });
  }

  if (action !== "test" && action !== "save") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  if (provider === "bluesky") {
    const handle = clean(body?.handle, 400);
    const password = clean(body?.password, 200);
    if (!handle || !password) {
      return NextResponse.json({ error: "Handle and app password are required." }, { status: 400 });
    }
    const t = await testBlueskyLogin(handle, password);
    if (action === "test") return NextResponse.json(t);
    if (!t.ok) {
      return NextResponse.json(
        { error: `Bluesky login failed — check the handle and app password. (${t.error || "unknown"})` },
        { status: 400 },
      );
    }
    const r = await setBlueskyCredentials(handle, password);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, status: await getIntegrationStatus() });
  }

  // provider === "threads"
  const userId = clean(body?.userId, 100);
  const accessToken = clean(body?.accessToken, 1000);
  if (!userId || !accessToken) {
    return NextResponse.json({ error: "User ID and access token are required." }, { status: 400 });
  }
  const t = await testThreadsToken(userId, accessToken);
  if (action === "test") return NextResponse.json(t);
  if (!t.ok) {
    return NextResponse.json(
      { error: `Threads check failed — verify the token and user ID. (${t.error || "unknown"})` },
      { status: 400 },
    );
  }
  const r = await setThreadsCredentials(userId, accessToken);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ success: true, status: await getIntegrationStatus() });
}
