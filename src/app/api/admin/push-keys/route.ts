import { NextRequest, NextResponse } from "next/server";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { secretBoxAvailable } from "@/lib/secret-box";
import {
  getPushKeyStatus,
  generateVapidKeys,
  setVapidKeys,
  clearVapidKeys,
} from "@/lib/push-config";

/**
 * Admin VAPID / web-push keys (#59): generate, save or clear the keys in-app
 * instead of editing `.env.local` + running `npx web-push generate-vapid-keys`.
 * The private key is stored AES-256-GCM-encrypted (push-config → secret-box) and
 * is NEVER returned to the client — GET reports only configured/source/subject.
 *
 * Cookie-only ON PURPOSE (`verifyAdmin`, no bearer path): keys are owner-only;
 * an app token must never read or rotate them — same stance as
 * /api/admin/analytics-key and /api/admin/integrations.
 *
 * ⚠️ generate / save / clear all PURGE every push subscription — see push-config.
 */

const CONTROL = /[\r\n]/;
const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return !t || t.length > max || CONTROL.test(t) ? null : t;
};

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    status: await getPushKeyStatus(),
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
  const subject = clean(body?.subject, 200) ?? undefined; // optional mailto:

  if (action === "clear") {
    await clearVapidKeys();
    return NextResponse.json({ success: true, status: await getPushKeyStatus() });
  }

  if (action === "generate") {
    const r = await generateVapidKeys(subject);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, status: await getPushKeyStatus() });
  }

  if (action === "save") {
    const publicKey = clean(body?.publicKey, 500);
    const privateKey = clean(body?.privateKey, 500);
    if (!publicKey || !privateKey) {
      return NextResponse.json({ error: "Both a public and private VAPID key are required." }, { status: 400 });
    }
    const r = await setVapidKeys(publicKey, privateKey, subject);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, status: await getPushKeyStatus() });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
