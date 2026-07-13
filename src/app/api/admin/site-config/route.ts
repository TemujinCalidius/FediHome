import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import {
  siteConfigDefaults,
  getRuntimeSiteConfig,
  applySiteConfig,
  SITE_CONFIG_KEYS,
} from "@/lib/site-settings";

/**
 * Admin site config (#59) — the safe display/feature settings, editable in-app
 * with no file editing or restart. Backed by the `SiteSetting` KV table; an
 * override beats the env default, `null` deletes it (revert to env). The site's
 * pages re-read via a 60s cache invalidated on save. The validate + persist
 * logic is shared with the first-run wizard (applySiteConfig in site-settings).
 *
 * Cookie-only ON PURPOSE (verifyAdmin, no bearer): instance configuration is an
 * owner surface — an app token must not reconfigure the site (same stance as
 * /api/admin/settings and /api/admin/apps).
 */

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = await prisma.siteSetting.findMany({ where: { key: { in: SITE_CONFIG_KEYS } } });
  return NextResponse.json({
    defaults: siteConfigDefaults(),
    effective: await getRuntimeSiteConfig(),
    overrides: Object.fromEntries(rows.map((r) => [r.key, r.value])),
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
  const result = await applySiteConfig(body?.settings);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true, effective: await getRuntimeSiteConfig() });
}
