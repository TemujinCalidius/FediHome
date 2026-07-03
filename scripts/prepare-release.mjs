#!/usr/bin/env node
/**
 * Deterministic release prep — the ONLY supported way to convert
 * `## Unreleased` into a version section, so the rename/bump can't be
 * hand-edited inconsistently again.
 *
 *   node scripts/prepare-release.mjs <major|minor|patch|X.Y.Z>
 *
 * Does, atomically in the working tree:
 *   1. CHANGELOG.md — renames `## Unreleased` → `## X.Y.Z (<today>)`.
 *      Refuses if the section is missing or empty.
 *   2. package.json + package-lock.json — bumps `version`.
 *
 * Then commit on a release branch, PR → dev, and merge dev → main per
 * docs/releasing.md. CI's changelog-sync job validates the result on both PRs.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const UNRELEASED_HEADING = "## Unreleased";

export function bumpVersion(current, arg) {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`package.json version ${JSON.stringify(current)} is not X.Y.Z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (arg === "major") return `${major + 1}.0.0`;
  if (arg === "minor") return `${major}.${minor + 1}.0`;
  if (arg === "patch") return `${major}.${minor}.${patch + 1}`;
  const e = SEMVER.exec(arg);
  if (!e) throw new Error(`version argument must be major|minor|patch|X.Y.Z, got ${JSON.stringify(arg)}`);
  const next = e.slice(1).map(Number);
  const cur = [major, minor, patch];
  const greater =
    next[0] > cur[0] ||
    (next[0] === cur[0] && (next[1] > cur[1] || (next[1] === cur[1] && next[2] > cur[2])));
  if (!greater) throw new Error(`${arg} is not greater than the current version ${current}`);
  return arg;
}

/**
 * Rename the Unreleased heading to a version heading. Throws if the section
 * is absent, duplicated, or has no content (nothing to release).
 */
export function convertUnreleased(changelog, version, dateStr) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const idxs = lines.reduce((acc, line, i) => (line === UNRELEASED_HEADING ? [...acc, i] : acc), []);
  if (idxs.length === 0) throw new Error("no '## Unreleased' section — nothing to release");
  if (idxs.length > 1) throw new Error("multiple '## Unreleased' sections — fix the changelog first");

  const start = idxs[0];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).filter((l) => l.trim() !== "");
  if (body.length === 0) throw new Error("the '## Unreleased' section is empty — nothing to release");

  lines[start] = `## ${version} (${dateStr})`;
  return lines.join("\n");
}

function localDate() {
  // The releaser's local date (releases are cut by a human in their tz).
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function bumpJsonFile(path, version, mutate) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  mutate(data, version);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: prepare-release.mjs <major|minor|patch|X.Y.Z>");
    process.exit(2);
  }

  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const version = bumpVersion(pkg.version, arg);
  const date = localDate();

  writeFileSync("CHANGELOG.md", convertUnreleased(readFileSync("CHANGELOG.md", "utf8"), version, date));
  bumpJsonFile("package.json", version, (data, v) => {
    data.version = v;
  });
  if (existsSync("package-lock.json")) {
    bumpJsonFile("package-lock.json", version, (data, v) => {
      data.version = v;
      if (data.packages && data.packages[""]) data.packages[""].version = v;
    });
  }

  console.log(`✓ Release ${version} prepared (${date}).`);
  console.log("  - CHANGELOG.md: '## Unreleased' → " + `'## ${version} (${date})'`);
  console.log("  - package.json / package-lock.json: version bumped");
  console.log("Next: commit on a release branch, PR → dev, then merge dev → main (see docs/releasing.md).");
}

// pathToFileURL handles spaces/non-ASCII in paths — a plain template-string
// comparison would silently do nothing (fail open) on such paths.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
