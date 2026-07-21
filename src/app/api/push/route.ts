import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import { getVapidPublicKey, pushConfigured } from "@/lib/push-config";

/**
 * Web Push subscription management for the owner.
 *
 *   GET    → { configured, publicKey, count }   (admin)
 *   POST   → save/refresh this device's subscription   (admin, CSRF-checked)
 *   DELETE → remove this device's subscription          (admin, CSRF-checked)
 */

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [count, configured, publicKey] = await Promise.all([
    prisma.pushSubscription.count(),
    pushConfigured(),
    getVapidPublicKey(),
  ]);
  return NextResponse.json({ configured, publicKey, count });
}

export async function POST(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const sub = (body as { subscription?: unknown })?.subscription as
    | { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
    | undefined;
  const userAgent =
    typeof (body as { userAgent?: unknown })?.userAgent === "string"
      ? ((body as { userAgent: string }).userAgent).slice(0, 300)
      : req.headers.get("user-agent")?.slice(0, 300) || null;

  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "incomplete subscription" }, { status: 400 });
  }

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { endpoint, p256dh, auth, userAgent },
    update: { p256dh, auth, userAgent, failures: 0, lastUsedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!verifyOrigin(req)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const endpoint = (body as { endpoint?: string })?.endpoint;
  if (!endpoint) {
    return NextResponse.json({ error: "missing endpoint" }, { status: 400 });
  }

  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
  return NextResponse.json({ ok: true });
}
