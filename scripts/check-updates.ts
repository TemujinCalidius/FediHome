#!/usr/bin/env tsx
/**
 * Checks for outdated packages, security advisories, and new release notes.
 * Upserts findings into MaintenanceItem so they surface in the notification bell.
 *
 * Run manually: npm run check-updates
 * Run on cron:   0 9 * * 1 cd /path/to/project && npm run check-updates
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err: unknown) {
    // npm outdated and audit exit non-zero when issues exist — capture stdout anyway
    const e = err as { stdout?: string };
    return e.stdout || "";
  }
}

async function checkOutdated() {
  const out = safeExec("npm outdated --json");
  if (!out.trim()) return 0;

  let parsed: Record<string, OutdatedEntry>;
  try {
    parsed = JSON.parse(out);
  } catch {
    return 0;
  }

  let count = 0;
  for (const [name, info] of Object.entries(parsed)) {
    if (!info.latest || info.current === info.latest) continue;

    const isMajor = info.current.split(".")[0] !== info.latest.split(".")[0];
    const title = `${name} ${info.current} → ${info.latest}${isMajor ? " (major)" : ""}`;

    try {
      await prisma.maintenanceItem.upsert({
        where: {
          kind_packageName_latest: {
            kind: "update",
            packageName: name,
            latest: info.latest,
          },
        },
        create: {
          kind: "update",
          packageName: name,
          current: info.current,
          latest: info.latest,
          title,
          url: `https://www.npmjs.com/package/${name}`,
        },
        update: { current: info.current, title },
      });
      count++;
    } catch {
      // ignore individual upsert failures
    }
  }
  return count;
}

async function checkSecurity() {
  const out = safeExec("npm audit --json");
  if (!out.trim()) return 0;

  let parsed: { vulnerabilities?: Record<string, AuditEntry> };
  try {
    parsed = JSON.parse(out);
  } catch {
    return 0;
  }

  let count = 0;
  for (const [name, entry] of Object.entries(parsed.vulnerabilities || {})) {
    for (const via of entry.via) {
      if (typeof via === "string") continue;
      try {
        const latestKey = via.range || "unspecified";
        await prisma.maintenanceItem.upsert({
          where: {
            kind_packageName_latest: {
              kind: "security",
              packageName: via.name || name,
              latest: latestKey,
            },
          },
          create: {
            kind: "security",
            packageName: via.name || name,
            latest: latestKey,
            severity: via.severity,
            title: via.title,
            description: `Affected range: ${via.range}`,
            url: via.url,
          },
          update: { severity: via.severity, title: via.title },
        });
        count++;
      } catch {
        // ignore
      }
    }
  }
  return count;
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

async function checkReleaseNotes() {
  let count = 0;
  for (const { pkg, repo } of WATCHLIST) {
    const installed = getInstalledVersion(pkg);
    if (!installed) continue;

    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const release = await res.json() as {
        tag_name?: string;
        name?: string;
        body?: string;
        html_url?: string;
        published_at?: string;
      };

      const tagVersion = (release.tag_name || "").replace(/^v/, "");
      if (!tagVersion) continue;

      // Skip if installed >= released
      if (compareVersions(installed, tagVersion) >= 0) continue;

      const title = release.name || release.tag_name || `${pkg} ${tagVersion}`;
      const body = (release.body || "").slice(0, 500);

      await prisma.maintenanceItem.upsert({
        where: {
          kind_packageName_latest: {
            kind: "release-note",
            packageName: pkg,
            latest: tagVersion,
          },
        },
        create: {
          kind: "release-note",
          packageName: pkg,
          current: installed,
          latest: tagVersion,
          title: `${pkg} ${tagVersion} — ${title}`,
          description: body,
          url: release.html_url,
        },
        update: { description: body, title: `${pkg} ${tagVersion} — ${title}` },
      });
      count++;
    } catch {
      // ignore individual failures
    }
  }
  return count;
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

async function main() {
  console.log("Checking for updates...");
  const updates = await checkOutdated();
  console.log(`  ${updates} package update(s) recorded`);

  console.log("Checking for security advisories...");
  const sec = await checkSecurity();
  console.log(`  ${sec} security advisory record(s) upserted`);

  console.log("Checking release notes for watchlist...");
  const rel = await checkReleaseNotes();
  console.log(`  ${rel} release note(s) recorded`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("check-updates failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
