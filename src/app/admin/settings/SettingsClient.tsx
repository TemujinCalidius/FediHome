"use client";

import { useState } from "react";
import Link from "next/link";
import type { SchedulerConfig } from "@/lib/scheduler-config";

/**
 * Instance settings (#59, first slice): the scheduler's jobs. Saves write
 * SiteSetting overrides via /api/admin/settings; the scheduler picks them up
 * within a minute (no restart). "Use env defaults" clears the overrides.
 */
export default function SettingsClient({
  defaults,
  effective,
  overrides,
  lastCheckedAt: initialLastCheckedAt,
}: {
  defaults: SchedulerConfig;
  effective: SchedulerConfig;
  overrides: Record<string, string>;
  lastCheckedAt: string | null;
}) {
  const [publishEnabled, setPublishEnabled] = useState(effective.publishScheduled.enabled);
  const [publishInterval, setPublishInterval] = useState(String(effective.publishScheduled.intervalSec));
  const [blueskyEnabled, setBlueskyEnabled] = useState(effective.blueskySync.enabled);
  const [blueskyInterval, setBlueskyInterval] = useState(String(effective.blueskySync.intervalSec));
  const [deliveryEnabled, setDeliveryEnabled] = useState(effective.deliveryRetry.enabled);
  const [deliveryInterval, setDeliveryInterval] = useState(String(effective.deliveryRetry.intervalSec));
  const [crosspostEnabled, setCrosspostEnabled] = useState(effective.crosspostRetry.enabled);
  const [crosspostInterval, setCrosspostInterval] = useState(String(effective.crosspostRetry.intervalSec));
  const [storageEnabled, setStorageEnabled] = useState(effective.storageScan.enabled);
  const [storageInterval, setStorageInterval] = useState(String(effective.storageScan.intervalSec));
  const [updateEnabled, setUpdateEnabled] = useState(effective.updateCheck.enabled);
  const [updateInterval, setUpdateInterval] = useState(String(effective.updateCheck.intervalSec));
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(initialLastCheckedAt);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const [retentionEnabled, setRetentionEnabled] = useState(effective.retentionSweep.enabled);
  const [retentionInterval, setRetentionInterval] = useState(String(effective.retentionSweep.intervalSec));
  const [retentionDays, setRetentionDays] = useState(String(effective.retentionSweep.retentionDays));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [hasOverrides, setHasOverrides] = useState(Object.keys(overrides).length > 0);

  /** Re-read the watermark after a manual check, so the label updates (#399). */
  async function loadLastChecked() {
    try {
      const res = await fetch("/api/maintenance/check");
      if (!res.ok) return;
      setLastCheckedAt((await res.json()).lastCheckedAt ?? null);
    } catch {
      /* nothing to show is fine */
    }
  }

  async function checkNow() {
    setChecking(true);
    setCheckMsg(null);
    try {
      const res = await fetch("/api/maintenance/check", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        // The check runs as a detached child process, so there is nothing to
        // await — it writes to the notification bell when it finishes.
        setCheckMsg("Started — results appear in your notifications shortly.");
        setTimeout(() => void loadLastChecked(), 2000);
      } else {
        setCheckMsg(data.error || "Couldn't start the check.");
      }
    } catch {
      setCheckMsg("Couldn't start the check.");
    } finally {
      setChecking(false);
    }
  }

  async function post(settings: Record<string, string | null>) {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, msg: data.error || "Save failed" });
        return false;
      }
      const eff = data.effective as SchedulerConfig;
      setPublishEnabled(eff.publishScheduled.enabled);
      setPublishInterval(String(eff.publishScheduled.intervalSec));
      setBlueskyEnabled(eff.blueskySync.enabled);
      setBlueskyInterval(String(eff.blueskySync.intervalSec));
      setDeliveryEnabled(eff.deliveryRetry.enabled);
      setDeliveryInterval(String(eff.deliveryRetry.intervalSec));
      setCrosspostEnabled(eff.crosspostRetry.enabled);
      setCrosspostInterval(String(eff.crosspostRetry.intervalSec));
      setStorageEnabled(eff.storageScan.enabled);
      setStorageInterval(String(eff.storageScan.intervalSec));
      setUpdateEnabled(eff.updateCheck.enabled);
      setUpdateInterval(String(eff.updateCheck.intervalSec));
      setRetentionEnabled(eff.retentionSweep.enabled);
      setRetentionInterval(String(eff.retentionSweep.intervalSec));
      setRetentionDays(String(eff.retentionSweep.retentionDays));
      setResult({ ok: true, msg: "Saved — the scheduler applies changes within a minute." });
      return true;
    } catch {
      setResult({ ok: false, msg: "Save failed" });
      return false;
    } finally {
      setSaving(false);
    }
  }

  const save = async () => {
    if (
      await post({
        "scheduler.publish.enabled": publishEnabled ? "true" : "false",
        "scheduler.publish.intervalSec": publishInterval,
        "scheduler.bluesky.enabled": blueskyEnabled ? "true" : "false",
        "scheduler.bluesky.intervalSec": blueskyInterval,
        "scheduler.delivery.enabled": deliveryEnabled ? "true" : "false",
        "scheduler.delivery.intervalSec": deliveryInterval,
        "scheduler.crosspost.enabled": crosspostEnabled ? "true" : "false",
        "scheduler.crosspost.intervalSec": crosspostInterval,
        "scheduler.storage.enabled": storageEnabled ? "true" : "false",
        "scheduler.storage.intervalSec": storageInterval,
        "scheduler.updateCheck.enabled": updateEnabled ? "true" : "false",
        "scheduler.updateCheck.intervalSec": updateInterval,
        "scheduler.retention.enabled": retentionEnabled ? "true" : "false",
        "scheduler.retention.intervalSec": retentionInterval,
        "scheduler.retention.days": retentionDays,
      })
    ) {
      setHasOverrides(true);
    }
  };

  const useDefaults = async () => {
    if (
      await post({
        "scheduler.publish.enabled": null,
        "scheduler.publish.intervalSec": null,
        "scheduler.bluesky.enabled": null,
        "scheduler.bluesky.intervalSec": null,
        "scheduler.delivery.enabled": null,
        "scheduler.delivery.intervalSec": null,
        "scheduler.crosspost.enabled": null,
        "scheduler.crosspost.intervalSec": null,
        "scheduler.storage.enabled": null,
        "scheduler.storage.intervalSec": null,
        "scheduler.updateCheck.enabled": null,
        "scheduler.updateCheck.intervalSec": null,
        "scheduler.retention.enabled": null,
        "scheduler.retention.intervalSec": null,
        "scheduler.retention.days": null,
      })
    ) {
      setHasOverrides(false);
    }
  };

  const jobRow = (
    label: string,
    hint: string,
    enabled: boolean,
    setEnabled: (v: boolean) => void,
    interval: string,
    setInterval_: (v: string) => void,
    defaultInterval: number,
  ) => (
    <div className="flex flex-wrap items-center gap-4 py-4 border-b border-surface-800 last:border-b-0">
      <label className="flex items-center gap-2 min-w-56">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="text-sm text-white">{label}</span>
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-400">
        every
        <input
          type="number"
          min={10}
          max={86400}
          value={interval}
          onChange={(e) => setInterval_(e.target.value)}
          disabled={!enabled}
          className="w-24 bg-surface-800 border border-surface-700 rounded-md px-2 py-1 text-xs text-white disabled:opacity-50"
        />
        seconds <span className="text-gray-600">(default {defaultInterval}s)</span>
      </label>
      <p className="w-full text-xs text-gray-500 m-0">{hint}</p>
    </div>
  );

  return (
    <main className="max-w-2xl mx-auto px-4 py-10">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Instance settings</h1>
        <Link href="/timeline" className="text-xs text-gray-400 hover:text-white underline">
          ← Timeline
        </Link>
      </div>

      <section className="rounded-lg border border-surface-700 bg-surface-900 px-5">
        <div className="flex items-baseline justify-between pt-4">
          <h2 className="text-sm font-semibold text-white m-0">Scheduler</h2>
          <span className="text-xs text-gray-500">
            {hasOverrides ? "using saved overrides" : "using env defaults"}
          </span>
        </div>

        {jobRow(
          "Publish scheduled posts",
          "Checks for due scheduled posts and publishes them (federation + crossposts).",
          publishEnabled,
          setPublishEnabled,
          publishInterval,
          setPublishInterval,
          defaults.publishScheduled.intervalSec,
        )}
        {jobRow(
          "Bluesky sync",
          "Syncs the Bluesky follower graph, DMs, and notifications.",
          blueskyEnabled,
          setBlueskyEnabled,
          blueskyInterval,
          setBlueskyInterval,
          defaults.blueskySync.intervalSec,
        )}
        {jobRow(
          "Delivery retry",
          "Retries failed follower deliveries with backoff, so a transiently-down instance still gets your posts.",
          deliveryEnabled,
          setDeliveryEnabled,
          deliveryInterval,
          setDeliveryInterval,
          defaults.deliveryRetry.intervalSec,
        )}
        {jobRow(
          "Crosspost retry",
          "Retries failed Bluesky/Threads crossposts with backoff, so a transient blip at publish time doesn't lose the crosspost.",
          crosspostEnabled,
          setCrosspostEnabled,
          crosspostInterval,
          setCrosspostInterval,
          defaults.crosspostRetry.intervalSec,
        )}
        {jobRow(
          "Disk usage scan",
          "Measures how much space your media uses and trims the cache of other people's media when it exceeds its budget. Turning this off means the cache is never trimmed.",
          storageEnabled,
          setStorageEnabled,
          storageInterval,
          setStorageInterval,
          defaults.storageScan.intervalSec,
        )}

        {jobRow(
          "Check for updates",
          "Looks for new FediHome releases, package updates and security advisories, and tells you in your notifications. Makes outbound requests to the npm registry and GitHub.",
          updateEnabled,
          setUpdateEnabled,
          updateInterval,
          setUpdateInterval,
          defaults.updateCheck.intervalSec,
        )}

        <div className="flex flex-wrap items-center gap-3 pb-4 -mt-2">
          <button
            onClick={checkNow}
            disabled={checking}
            className="text-xs rounded-md border border-surface-700 px-3 py-1.5 text-gray-300 hover:text-white hover:border-surface-600 disabled:opacity-50"
          >
            {checking ? "Starting…" : "Check now"}
          </button>
          <span className="text-xs text-gray-500">
            {lastCheckedAt
              ? `Last checked ${new Date(lastCheckedAt).toLocaleString()}`
              : "Never checked"}
          </span>
          {checkMsg && <span className="text-xs text-gray-400">{checkMsg}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-4 py-4 border-b border-surface-800 last:border-b-0">
          <label className="flex items-center gap-2 min-w-56">
            <input
              type="checkbox"
              checked={retentionEnabled}
              onChange={(e) => setRetentionEnabled(e.target.checked)}
            />
            <span className="text-sm text-white">Federated data retention</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            every
            <input
              type="number"
              min={10}
              max={86400}
              value={retentionInterval}
              onChange={(e) => setRetentionInterval(e.target.value)}
              disabled={!retentionEnabled}
              className="w-24 bg-surface-800 border border-surface-700 rounded-md px-2 py-1 text-xs text-white disabled:opacity-50"
            />
            seconds <span className="text-gray-600">(default {defaults.retentionSweep.intervalSec}s)</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            prune remote posts older than
            <input
              type="number"
              min={7}
              max={3650}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              disabled={!retentionEnabled}
              className="w-20 bg-surface-800 border border-surface-700 rounded-md px-2 py-1 text-xs text-white disabled:opacity-50"
            />
            days <span className="text-gray-600">(default {defaults.retentionSweep.retentionDays})</span>
          </label>
          <p className="w-full text-xs text-gray-500 m-0">
            Off by default. Deletes cached copies of <strong>remote</strong> posts older than the window
            (re-fetchable from their origin) to bound disk growth. Your own posts, interactions on your
            posts, follows, and DMs are never pruned.
          </p>
        </div>

        <div className="flex items-center gap-3 py-4">
          <button onClick={save} disabled={saving} className="btn-primary disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={useDefaults}
            disabled={saving || !hasOverrides}
            className="text-xs text-gray-400 hover:text-white underline disabled:opacity-40 disabled:no-underline"
          >
            Use env defaults
          </button>
        </div>
      </section>

      {result && (
        <p className={`mt-4 text-sm ${result.ok ? "text-green-400" : "text-red-400"}`}>{result.msg}</p>
      )}

      <p className="mt-6 text-xs text-gray-500">
        Changes apply live — the scheduler re-reads its configuration every tick. Env vars
        (<code>SCHEDULER_*</code>) remain the defaults when no override is saved.
      </p>
    </main>
  );
}
