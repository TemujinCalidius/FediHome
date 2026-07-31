#!/usr/bin/env tsx
/**
 * Checks for outdated packages, security advisories, and new release notes.
 * Upserts findings into MaintenanceItem so they surface in the notification bell.
 *
 * Run manually: npm run check-updates
 * Run on cron:   0 9 * * 1 cd /path/to/project && npm run check-updates
 */
import { execSync } from "node:child_process";
import { buildSha } from "../src/lib/build-info";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/db";
import { raiseMaintenanceItem, seenKey, sweepResolved } from "../src/lib/maintenance";
import { installShape, updateInstruction } from "../src/lib/install-shape";

interface OutdatedEntry {
  current: string;
  wanted: string;
  latest: string;
}

interface AuditAdvisoryVia {
  source: number;
  name: string;
  title: string;
  url: string;
  severity: string;
  range: string;
}

interface AuditEntry {
  name: string;
  severity: string;
  via: (string | AuditAdvisoryVia)[];
}

const WATCHLIST: { pkg: string; repo: string }[] = [
  { pkg: "@fedify/fedify", repo: "fedify-dev/fedify" },
  { pkg: "next", repo: "vercel/next.js" },
  { pkg: "@prisma/client", repo: "prisma/prisma" },
  { pkg: "@atproto/api", repo: "bluesky-social/atproto" },
  { pkg: "react", repo: "facebook/react" },
];

/**
 * What a checker reports: how many items it raised, and how many it resolved
 * because the condition behind them no longer holds (#412).
 */
interface CheckResult {
  count: number;
  resolved: number;
}

/**
 * The result to return when a check could not run at all — a network failure, an
 * npm error, output that wouldn't parse.
 *
 * It reports **no sweep**, deliberately: a sweep means "I enumerated everything
 * and these are gone", and a check that failed enumerated nothing. Resolving on
 * failure would clear every outstanding alert the first time `npm audit` couldn't
 * reach the registry — including a real advisory. Failing safe means an alert
 * that is no longer true lingers until the next successful run, which is the far
 * better of the two mistakes.
 */
const DID_NOT_RUN: CheckResult = { count: 0, resolved: 0 };

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err: unknown) {
    // npm outdated and audit exit non-zero when issues exist — capture stdout anyway
    const e = err as { stdout?: string };
    return e.stdout || "";
  }
}

async function checkOutdated(): Promise<CheckResult> {
  const out = safeExec("npm outdated --json");
  if (!out.trim()) return DID_NOT_RUN;

  let parsed: Record<string, OutdatedEntry>;
  try {
    parsed = JSON.parse(out);
  } catch {
    return DID_NOT_RUN;
  }

  let count = 0;
  const seen = new Set<string>();
  for (const [name, info] of Object.entries(parsed)) {
    if (!info.latest || info.current === info.latest) continue;

    const isMajor = info.current.split(".")[0] !== info.latest.split(".")[0];
    const title = `${name} ${info.current} → ${info.latest}${isMajor ? " (major)" : ""}`;
    seen.add(seenKey(name, info.latest));

    try {
      await raiseMaintenanceItem(
        {
          kind: "update",
          packageName: name,
          current: info.current,
          latest: info.latest,
          title,
          url: `https://www.npmjs.com/package/${name}`,
        },
        { refresh: true }, // `current` moves as a dependency tree is partly upgraded
      );
      count++;
    } catch {
      // ignore individual failures
    }
  }

  // Anything `npm outdated` no longer lists has been upgraded past — or the
  // upstream release it named has itself been superseded, which is how one live
  // row per upstream version used to pile up (#412).
  //
  // `fedihome` is excepted because it is not an npm dependency: the release-tag
  // fallback below writes it under this same kind, and it sweeps its own.
  const resolved = await sweepResolved("update", seen, { exceptPackages: ["fedihome"] });
  return { count, resolved };
}

async function checkSecurity(): Promise<CheckResult> {
  const out = safeExec("npm audit --json");
  if (!out.trim()) return DID_NOT_RUN;

  let parsed: { vulnerabilities?: Record<string, AuditEntry> };
  try {
    parsed = JSON.parse(out);
  } catch {
    return DID_NOT_RUN;
  }

  let count = 0;
  const seen = new Set<string>();
  for (const [name, entry] of Object.entries(parsed.vulnerabilities || {})) {
    for (const via of entry.via) {
      if (typeof via === "string") continue;
      const pkg = via.name || name;
      const latestKey = via.range || "unspecified";
      seen.add(seenKey(pkg, latestKey));
      try {
        await raiseMaintenanceItem(
          {
            kind: "security",
            packageName: pkg,
            latest: latestKey,
            severity: via.severity,
            title: via.title,
            description: `Affected range: ${via.range}`,
            url: via.url,
          },
          { refresh: true }, // an advisory's severity gets revised upstream
        );
        count++;
      } catch {
        // ignore
      }
    }
  }

  // The case this exists for: a fixed advisory. A clean `npm audit` produces zero
  // iterations, so before the sweep NOTHING reconciled — an instance that checked
  // once while an advisory was live kept reporting it long after `npm audit` went
  // to zero. Of everything in #412 that is the one that actively misleads, since
  // it is the alert an owner is most likely to act on.
  //
  // The boot-time credential and identity alerts also live under `security`; they
  // are exempt in NEVER_SWEPT, because `npm audit` has no opinion about either.
  const resolved = await sweepResolved("security", seen);
  return { count, resolved };
}

function getInstalledVersion(pkg: string): string | null {
  const path = join(process.cwd(), "node_modules", pkg, "package.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw).version as string;
  } catch {
    return null;
  }
}

async function checkReleaseNotes(): Promise<CheckResult> {
  let count = 0;
  const seen = new Set<string>();
  let reachedAll = true;
  for (const { pkg, repo } of WATCHLIST) {
    const installed = getInstalledVersion(pkg);
    if (!installed) continue;

    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        reachedAll = false;
        continue;
      }
      const release = await res.json() as {
        tag_name?: string;
        name?: string;
        body?: string;
        html_url?: string;
        published_at?: string;
      };

      const tagVersion = (release.tag_name || "").replace(/^v/, "");
      if (!tagVersion) continue;

      // Skip if installed >= released. Nothing is added to `seen`, so any note we
      // filed for an earlier version gets swept once it's installed.
      if (compareVersions(installed, tagVersion) >= 0) continue;

      const title = release.name || release.tag_name || `${pkg} ${tagVersion}`;
      const body = (release.body || "").slice(0, 500);
      seen.add(seenKey(pkg, tagVersion));

      await raiseMaintenanceItem(
        {
          kind: "release-note",
          packageName: pkg,
          current: installed,
          latest: tagVersion,
          title: `${pkg} ${tagVersion} — ${title}`,
          description: body,
          url: release.html_url,
        },
        { refresh: true }, // release bodies get edited after publication
      );
      count++;
    } catch {
      reachedAll = false; // ignore the individual failure, but don't sweep on it
    }
  }

  // Only sweep when every watched repo answered. One unreachable repo means its
  // notes are missing from `seen` for a reason that has nothing to do with the
  // owner having upgraded.
  //
  // `fedihome` is excepted: checkFediHomeSelf writes under this kind too, and it
  // reconciles its own rows against the commit it just compared.
  const resolved = reachedAll
    ? await sweepResolved("release-note", seen, { exceptPackages: ["fedihome"] })
    : 0;
  return { count, resolved };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

const FEDIHOME_REPO = process.env.FEDIHOME_REPO || "TemujinCalidius/fedihome";
const FEDIHOME_BRANCH = process.env.FEDIHOME_BRANCH || "main";

// Compare the local checkout's HEAD against the upstream branch tip on GitHub.
// If we're behind, surface a single "FediHome update available" maintenance
// item with the latest commit subjects so the admin can see what's new at a
// glance, and the command that will actually apply it on THIS install (#398) —
// this used to say `npm run update` to everyone, which in a container refuses.
async function checkFediHomeSelf(): Promise<CheckResult> {
  // A git checkout is the precise signal, but it's absent in every container
  // (.dockerignore excludes .git) and in tarball installs — which used to mean
  // this silently returned 0 and those users simply never heard about a new
  // release. Fall back to the SHA baked in at image build time (#358), and
  // failing that, compare the release TAG instead of the commit (#361).
  let localSha: string | null = buildSha();
  if (!localSha) {
    try {
      // stderr discarded: the runner image has no `git` at all, so this prints
      // "git: not found" on every container run — which reads as a failure when
      // it is the expected path into the release-tag fallback below.
      localSha =
        execSync("git rev-parse HEAD", {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
    } catch {
      localSha = null;
    }
  }
  if (!localSha) return await checkFediHomeByReleaseTag();

  const shape = installShape();

  try {
    const res = await fetch(
      `https://api.github.com/repos/${FEDIHOME_REPO}/commits/${FEDIHOME_BRANCH}`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) return DID_NOT_RUN;
    const head = (await res.json()) as { sha?: string };
    const remoteSha = head.sha;
    if (!remoteSha) return DID_NOT_RUN;

    if (remoteSha === localSha) {
      // Up to date, so nothing about FediHome itself is outstanding. Resolve
      // whichever kind previously carried it: an install can switch between the
      // commit check and the release-tag fallback (a container gains a build SHA,
      // a tarball install becomes a git checkout), and the old cleanup only ever
      // looked at `release-note` — so a container that had taken the tag path
      // kept its stale row forever (#412).
      const resolved =
        (await sweepSelf("release-note")) + (await sweepSelf("update"));
      return { count: 0, resolved };
    }

    // Behind. Pull the list of commits between local..remote (newest first)
    // and use them for a human-readable description.
    let description = "";
    try {
      const compare = await fetch(
        `https://api.github.com/repos/${FEDIHOME_REPO}/compare/${localSha}...${remoteSha}`,
        {
          headers: { Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (compare.ok) {
        const data = (await compare.json()) as {
          ahead_by?: number;
          commits?: { sha: string; commit: { message: string } }[];
        };
        const ahead = data.ahead_by ?? 0;
        const lines = (data.commits || [])
          .slice(-10)
          .reverse()
          .map((c) => `• ${c.commit.message.split("\n")[0]}`);
        description = `${ahead} new commit${ahead === 1 ? "" : "s"} on ${FEDIHOME_BRANCH}:\n${lines.join("\n")}\n\n${updateInstruction(shape)}`;
      }
    } catch {
      // Compare endpoint failed — fall back to a generic message
    }

    const shortSha = remoteSha.slice(0, 7);
    const installedVersion = readInstalledFediHomeVersion();

    await raiseMaintenanceItem(
      {
        kind: "release-note",
        packageName: "fedihome",
        current: installedVersion,
        latest: shortSha,
        title: `FediHome update available (${shortSha})`,
        description: description || `New commits on ${FEDIHOME_BRANCH}. ${updateInstruction(shape)}`,
        url: `https://github.com/${FEDIHOME_REPO}/compare/${localSha}...${remoteSha}`,
      },
      { refresh: true }, // the commit list grows while you stay on the same tip
    );

    // Only the newest tip is news; every superseded SHA is resolved, along with
    // any row the release-tag fallback left behind under the other kind.
    const resolved =
      (await sweepSelf("release-note", shortSha)) + (await sweepSelf("update"));

    return { count: 1, resolved };
  } catch {
    return DID_NOT_RUN;
  }
}

/**
 * Resolve FediHome's own update rows of one kind, optionally keeping the one
 * identity that is still current.
 *
 * There are two of these because the check has two methods — commit comparison
 * (`release-note`) and release tag (`update`) — and an install can move between
 * them. Whichever ran, the other's rows are stale by definition.
 */
async function sweepSelf(kind: string, keep?: string): Promise<number> {
  const seen = keep ? new Set([seenKey("fedihome", keep)]) : new Set<string>();
  const live = await prisma.maintenanceItem.findMany({
    where: { kind, packageName: "fedihome", resolvedAt: null },
    select: { id: true, latest: true },
  });
  const gone = live.filter((m) => !seen.has(seenKey("fedihome", m.latest ?? ""))).map((m) => m.id);
  if (gone.length === 0) return 0;
  await prisma.maintenanceItem.updateMany({
    where: { id: { in: gone } },
    data: { resolvedAt: new Date() },
  });
  return gone.length;
}

function readInstalledFediHomeVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/** `3 recorded, 2 resolved` — or just `3 recorded` when nothing cleared. */
function report(label: string, r: CheckResult): void {
  const resolved = r.resolved > 0 ? `, ${r.resolved} resolved` : "";
  console.log(`  ${r.count} ${label}${resolved}`);
}

async function main() {
  console.log("Checking for FediHome updates...");
  report("FediHome update(s) recorded", await checkFediHomeSelf());

  console.log("Checking for outdated packages...");
  report("package update(s) recorded", await checkOutdated());

  console.log("Checking for security advisories...");
  report("security advisory record(s) recorded", await checkSecurity());

  console.log("Checking release notes for watchlist...");
  report("release note(s) recorded", await checkReleaseNotes());

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("check-updates failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});

/**
 * Version-based update check, for installs with no commit SHA available at all.
 *
 * Less precise than the commit comparison — it only notices tagged releases, not
 * every commit on `main` — but "less precise" beats the previous behaviour of
 * saying nothing whatsoever. Records that it used the coarser method so the
 * result isn't mistaken for a commit-accurate one.
 */
async function checkFediHomeByReleaseTag(): Promise<CheckResult> {
  try {
    const res = await fetch(`https://api.github.com/repos/${FEDIHOME_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "fedihome-update-check" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return DID_NOT_RUN;
    const rel = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
    const latest = (rel.tag_name || "").replace(/^v/, "");
    if (!latest) return DID_NOT_RUN;

    const current = readInstalledFediHomeVersion();

    // Up to date. This is the path a container takes by default — FEDIHOME_BUILD_SHA
    // is only set if you pass it to `docker compose build` — and it wrote under
    // `kind: "update"`, which NEITHER old cleanup matched (both filtered
    // `release-note`). So a container collected one permanent row per tagged
    // release: after four releases the bell claimed four updates were available
    // when the answer was none (#412).
    if (latest === current || !isNewer(latest, current)) {
      const resolved = (await sweepSelf("update")) + (await sweepSelf("release-note"));
      return { count: 0, resolved };
    }

    await raiseMaintenanceItem({
      kind: "update",
      packageName: "fedihome",
      current,
      latest,
      severity: "info",
      title: `FediHome ${latest} is available`,
      description:
        `You're running ${current}. ${updateInstruction()}\n\n` +
        `This check compared release versions rather than commits, because this install ` +
        `has no commit SHA available (a container built without a build SHA, or a tarball ` +
        `install), so it only notices tagged releases.`,
      url: rel.html_url || `https://github.com/${FEDIHOME_REPO}/releases/latest`,
    });

    // Every older release we flagged is superseded by this one.
    const resolved = (await sweepSelf("update", latest)) + (await sweepSelf("release-note"));
    return { count: 1, resolved };
  } catch {
    return DID_NOT_RUN;
  }
}

/** Naive semver-ish comparison — enough for our own x.y.z tags. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
