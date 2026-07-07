import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import {
  siteConfigDefaults,
  getRuntimeSiteConfig,
  invalidateSiteConfigCache,
  SITE_CONFIG_FIELDS,
  SITE_CONFIG_KEYS,
} from "@/lib/site-settings";

/**
 * Admin site config (#59) — the safe display/feature settings, editable in-app
 * with no file editing or restart. Backed by the `SiteSetting` KV table; an
 * override beats the env default, `null` deletes it (revert to env). The site's
 * pages re-read via a 60s cache invalidated on save.
 *
 * Cookie-only ON PURPOSE (verifyAdmin, no bearer): instance configuration is an
 * owner surface — an app token must not reconfigure the site (same stance as
 * /api/admin/settings and /api/admin/apps).
 */

const KEY_SET = new Set<string>(SITE_CONFIG_KEYS);
const MAX_TEXT = 500;
const CONTROL = /[\r\n]/;

/** Returns the validated value, or null if invalid. Empty string is allowed
 * (clears a text/url field to its "unset" state). */
function validate(key: string, value: string): string | null {
  const type = SITE_CONFIG_FIELDS[key];
  if (type === "bool") {
    return value === "true" || value === "false" ? value : null;
  }
  if (value.length > MAX_TEXT || CONTROL.test(value)) return null;
  if (type === "url") {
    if (value === "") return value; // empty = hidden/unset
    // Same-origin relative, or an absolute http(s) URL — never javascript:/data:.
    // (footer.badgeSrc is an <img> src and rides the existing CSP img-src.)
    if (value.startsWith("/") && !value.startsWith("//")) return value;
    try {
      const u = new URL(value);
      return u.protocol === "http:" || u.protocol === "https:" ? value : null;
    } catch {
      return null;
    }
  }
  return value; // text
}

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
  const settings = body?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return NextResponse.json({ error: "settings object required" }, { status: 400 });
  }

  const entries = Object.entries(settings as Record<string, unknown>);
  if (entries.length === 0 || entries.length > SITE_CONFIG_KEYS.length) {
    return NextResponse.json({ error: "invalid settings payload" }, { status: 400 });
  }

  // Validate everything before writing anything.
  const writes: Array<{ key: string; value: string | null }> = [];
  for (const [key, raw] of entries) {
    if (!KEY_SET.has(key)) {
      return NextResponse.json({ error: `unknown setting: ${key}` }, { status: 400 });
    }
    if (raw === null) {
      writes.push({ key, value: null }); // revert to default
      continue;
    }
    if (typeof raw !== "string") {
      return NextResponse.json({ error: `${key} must be a string or null` }, { status: 400 });
    }
    const valid = validate(key, raw);
    if (valid === null) {
      return NextResponse.json({ error: `invalid value for ${key}` }, { status: 400 });
    }
    writes.push({ key, value: valid });
  }

  for (const { key, value } of writes) {
    if (value === null) {
      await prisma.siteSetting.deleteMany({ where: { key } });
    } else {
      await prisma.siteSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
  }

  invalidateSiteConfigCache();
  return NextResponse.json({ success: true, effective: await getRuntimeSiteConfig() });
}
