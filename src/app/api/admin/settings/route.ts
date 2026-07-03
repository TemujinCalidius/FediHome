import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAdmin, verifyOrigin } from "@/lib/auth";
import {
  getSchedulerConfig,
  getEffectiveSchedulerConfig,
  invalidateSchedulerConfigCache,
  SCHEDULER_SETTING_KEYS,
  type SchedulerSettingKey,
} from "@/lib/scheduler-config";

/**
 * Admin instance settings (#59 — first slice: the scheduler). Backed by the
 * `SiteSetting` key-value table; an override row beats the env default, and
 * deleting the row reverts to it. The scheduler re-reads config every tick
 * (60s cache, invalidated on save), so changes apply live — no restart.
 *
 * Cookie-only ON PURPOSE (verifyAdmin, no bearer path): instance
 * configuration is owner-surface, an app token must not be able to
 * reconfigure the scheduler — same stance as /api/admin/apps.
 */

const KEY_SET = new Set<string>(SCHEDULER_SETTING_KEYS);
const INTERVAL_RE = /^\d{1,6}$/;
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 86_400;

function validateValue(key: SchedulerSettingKey, value: string): string | null {
  if (key.endsWith(".enabled")) {
    return value === "true" || value === "false" ? value : null;
  }
  if (!INTERVAL_RE.test(value)) return null;
  const n = Number(value);
  return n >= MIN_INTERVAL_SEC && n <= MAX_INTERVAL_SEC ? String(n) : null;
}

export async function GET(req: NextRequest) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = await prisma.siteSetting.findMany({
    where: { key: { in: [...SCHEDULER_SETTING_KEYS] } },
  });
  return NextResponse.json({
    defaults: getSchedulerConfig(),
    effective: await getEffectiveSchedulerConfig(),
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
  if (entries.length === 0 || entries.length > SCHEDULER_SETTING_KEYS.length) {
    return NextResponse.json({ error: "invalid settings payload" }, { status: 400 });
  }

  // Validate everything before writing anything.
  const writes: Array<{ key: SchedulerSettingKey; value: string | null }> = [];
  for (const [key, raw] of entries) {
    if (!KEY_SET.has(key)) {
      return NextResponse.json({ error: `unknown setting: ${key}` }, { status: 400 });
    }
    if (raw === null) {
      writes.push({ key: key as SchedulerSettingKey, value: null }); // revert to default
      continue;
    }
    if (typeof raw !== "string") {
      return NextResponse.json({ error: `${key} must be a string or null` }, { status: 400 });
    }
    const valid = validateValue(key as SchedulerSettingKey, raw);
    if (valid === null) {
      return NextResponse.json({ error: `invalid value for ${key}` }, { status: 400 });
    }
    writes.push({ key: key as SchedulerSettingKey, value: valid });
  }

  for (const { key, value } of writes) {
    if (value === null) {
      await prisma.siteSetting.deleteMany({ where: { key } });
    } else {
      await prisma.siteSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    }
  }

  invalidateSchedulerConfigCache();
  return NextResponse.json({ success: true, effective: await getEffectiveSchedulerConfig() });
}
