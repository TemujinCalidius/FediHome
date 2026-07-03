#!/usr/bin/env node
/**
 * CHANGELOG structural sync check (CI).
 *
 * Enforces the branch model's changelog invariants so released history can
 * never silently drift between dev and main again (it has, twice — a dropped
 * `## 1.6.0` heading, and near-misses around the 1.7.0 release):
 *
 *  dev mode  (PRs targeting dev):
 *    - Released history is immutable: everything from the first version
 *      heading down must equal main's byte-for-byte (modulo line endings and
 *      trailing blank lines at EOF) — optionally preceded by ONE new version
 *      section whose version matches package.json, is semver-greater than
 *      main's latest, and was never released before (a release-prep PR
 *      renaming Unreleased → vX.Y.Z).
 *    - The header zone (above the first version heading, `## Unreleased`
 *      block excluded) must equal main's — no parking content there.
 *
 *  release mode  (PRs targeting main):
 *    No `## Unreleased` heading may remain (release prep must have converted
 *    it), and the top version heading must match package.json's version.
 *
 * Both modes validate heading syntax. Detection is CommonMark-aware: anything
 * that would RENDER as an h1/h2 (up to 3 leading spaces, space/tab after the
 * hashes) is treated as a heading and must be in canonical form —
 * `## Unreleased` or `## X.Y.Z (YYYY-MM-DD)` — so a spoofed heading can't
 * slip past as body text. Fenced code blocks are skipped.
 *
 * CLI:
 *   node scripts/check-changelog-sync.mjs dev --base-ref origin/main
 *   node scripts/check-changelog-sync.mjs release
 *
 * Exits 1 with `::error::`-prefixed messages (GitHub Actions annotations).
 * Deliberate edits to released history (e.g. fixing a typo in an old entry)
 * can bypass the CI job with the `changelog-resync` PR label.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION_HEADING = /^## (\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)$/;
const UNRELEASED_HEADING = "## Unreleased";
// Anything CommonMark renders as a heading at this level: up to 3 leading
// spaces, then the hashes, then space/tab/end-of-line.
const H2_RENDERED = /^ {0,3}##(?:[ \t]|$)/;
const H1_RENDERED = /^ {0,3}#(?:[ \t]|$)/;
const FENCE = /^ {0,3}(?:```|~~~)/;

/** Normalize line endings and split into lines. */
export function toLines(text) {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * One fence-aware pass classifying every line. Returns
 * [{ line, index, h1, h2, version }] for lines that render as headings.
 */
function scanHeadings(lines) {
  const out = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (H2_RENDERED.test(line)) {
      out.push({ line, index, h1: false, h2: true, version: VERSION_HEADING.exec(line)?.[1] ?? null });
    } else if (H1_RENDERED.test(line)) {
      out.push({ line, index, h1: true, h2: false, version: null });
    }
  }
  return out;
}

/**
 * Validate heading syntax + ordering rules shared by both modes.
 * Returns a list of error strings (empty = ok).
 */
export function validateHeadings(lines) {
  const errors = [];
  const hs = scanHeadings(lines);
  const h2s = hs.filter((h) => h.h2);
  const unreleased = h2s.filter((h) => h.line === UNRELEASED_HEADING);

  for (const { line, index } of h2s) {
    if (line !== UNRELEASED_HEADING && !VERSION_HEADING.test(line)) {
      errors.push(
        `line ${index + 1}: malformed heading ${JSON.stringify(line)} — expected exactly "## Unreleased" or "## X.Y.Z (YYYY-MM-DD)" (no leading whitespace or tabs)`,
      );
    }
  }
  const h1s = hs.filter((h) => h.h1);
  for (const { line, index } of h1s) {
    if (line !== "# Changelog" || index !== h1s[0].index) {
      errors.push(
        `line ${index + 1}: unexpected top-level heading ${JSON.stringify(line)} — only one "# Changelog" title is allowed`,
      );
    }
  }
  if (unreleased.length > 1) {
    errors.push(`multiple "## Unreleased" headings (lines ${unreleased.map((h) => h.index + 1).join(", ")})`);
  }
  const firstVersion = h2s.find((h) => h.version);
  if (unreleased.length === 1 && firstVersion && unreleased[0].index > firstVersion.index) {
    errors.push(`"## Unreleased" (line ${unreleased[0].index + 1}) must come before all version sections`);
  }
  return errors;
}

function firstVersionIndex(lines) {
  const hs = scanHeadings(lines);
  return hs.find((h) => h.version)?.index ?? -1;
}

/**
 * The released history: every line from the first version heading to EOF,
 * with trailing blank lines trimmed (EOF-newline churn isn't history drift).
 */
export function releasedBody(lines) {
  const first = firstVersionIndex(lines);
  if (first === -1) return [];
  const body = lines.slice(first);
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  return body;
}

/**
 * The header zone: lines above the first version heading, with the
 * `## Unreleased` block (its heading through the end of the zone) and
 * trailing blank lines removed. On a well-formed changelog this is just the
 * `# Changelog` title.
 */
export function headerZone(lines) {
  const stop = firstVersionIndex(lines);
  const zone = lines.slice(0, stop === -1 ? lines.length : stop);
  const unreleasedAt = zone.findIndex((line) => line === UNRELEASED_HEADING);
  const header = unreleasedAt === -1 ? zone : zone.slice(0, unreleasedAt);
  while (header.length && header[header.length - 1].trim() === "") header.pop();
  return header;
}

/** Version string from the top version heading, or null. */
export function topVersion(lines) {
  return scanHeadings(lines).find((h) => h.version)?.version ?? null;
}

function semverGreater(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

function sameLines(a, b) {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * dev mode: PR changelog vs main's changelog + package.json version.
 * Returns a list of error strings (empty = pass).
 */
export function checkDevSync(prText, mainText, pkgVersion) {
  const prLines = toLines(prText);
  const mainLines = toLines(mainText);
  const errors = validateHeadings(prLines);

  // The header above the first version section is locked to main's — the
  // only mutable zones are the Unreleased block and a release-prep section.
  if (!sameLines(headerZone(prLines), headerZone(mainLines))) {
    errors.push(
      "the changelog header (above '## Unreleased' / the first version section) differs from main's — content can only be added under '## Unreleased'",
    );
  }

  const prReleased = releasedBody(prLines);
  const mainReleased = releasedBody(mainLines);

  // main's released history must be a strict suffix of the PR's.
  const tail = prReleased.slice(prReleased.length - mainReleased.length);
  const tailMatches =
    mainReleased.length <= prReleased.length && tail.every((line, i) => line === mainReleased[i]);

  if (!tailMatches) {
    // Point at the first divergence to make the failure actionable.
    let hint = "";
    if (prReleased.length < mainReleased.length) {
      hint = ` This branch's released history is ${mainReleased.length - prReleased.length} line(s) shorter than main's — a released section was likely dropped (e.g. by a bad merge-conflict resolution).`;
    } else {
      for (let i = 0; i < mainReleased.length; i++) {
        const prLine = prReleased[prReleased.length - mainReleased.length + i];
        if (prLine !== mainReleased[i]) {
          hint = ` First divergence: main has ${JSON.stringify(mainReleased[i])}, this branch has ${JSON.stringify(prLine)}.`;
          break;
        }
      }
    }
    errors.push(
      "released sections don't match main's CHANGELOG — a released heading/entry was edited, dropped, or reordered on this branch." +
        hint +
        " New entries belong under '## Unreleased'. If dev is missing a hotfix released on main, back-merge main into dev. For a deliberate fix to released history, apply the 'changelog-resync' label.",
    );
    return errors;
  }

  // Whatever precedes main's history must be nothing, or ONE new release-prep section.
  const prefix = prReleased.slice(0, prReleased.length - mainReleased.length);
  if (prefix.length > 0) {
    const prefixH2s = scanHeadings(prefix).filter((h) => h.h2);
    const m = VERSION_HEADING.exec(prefix[0] ?? "");
    const mainVersions = new Set(scanHeadings(mainReleased).flatMap((h) => (h.version ? [h.version] : [])));
    const mainTop = topVersion(mainReleased);
    if (!m || prefixH2s.length !== 1) {
      errors.push(
        "more than one new version section above main's history — a release-prep PR may add exactly one (the release being cut)",
      );
    } else if (m[1] !== pkgVersion) {
      errors.push(
        `new version section "${m[1]}" doesn't match package.json version "${pkgVersion}" — bump package.json in the same PR (use scripts/prepare-release.mjs)`,
      );
    } else if (mainVersions.has(m[1])) {
      errors.push(`new version section "${m[1]}" was already released on main`);
    } else if (mainTop && !semverGreater(m[1], mainTop)) {
      errors.push(`new version section "${m[1]}" isn't greater than main's latest release ${mainTop}`);
    }
  }
  return errors;
}

/**
 * release mode: the changelog about to land on main + package.json version.
 * Returns a list of error strings (empty = pass).
 */
export function checkReleaseReady(text, pkgVersion) {
  const lines = toLines(text);
  const errors = validateHeadings(lines);

  if (lines.some((line) => line === UNRELEASED_HEADING)) {
    errors.push(
      "an '## Unreleased' section is still present — run scripts/prepare-release.mjs to convert it to the release version before merging to main",
    );
  }
  const top = topVersion(lines);
  if (!top) {
    errors.push("no version sections found");
  } else if (top !== pkgVersion) {
    errors.push(
      `top CHANGELOG version "${top}" doesn't match package.json version "${pkgVersion}" — release prep must bump both together`,
    );
  }
  return errors;
}

/* ---------------------------------- CLI ---------------------------------- */

function fail(errors) {
  for (const e of errors) console.error(`::error::CHANGELOG: ${e}`);
  process.exit(1);
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const baseRefIdx = rest.indexOf("--base-ref");
  const baseRef = baseRefIdx !== -1 ? rest[baseRefIdx + 1] : "origin/main";

  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

  if (mode === "dev") {
    const { execFileSync } = await import("node:child_process");
    const mainChangelog = execFileSync("git", ["show", `${baseRef}:CHANGELOG.md`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const errors = checkDevSync(changelog, mainChangelog, pkgVersion);
    if (errors.length) fail(errors);
    console.log(`✓ CHANGELOG released sections match ${baseRef}; Unreleased block is well-formed.`);
  } else if (mode === "release") {
    const errors = checkReleaseReady(changelog, pkgVersion);
    if (errors.length) fail(errors);
    console.log(`✓ CHANGELOG is release-ready: top section ${pkgVersion}, no Unreleased block.`);
  } else {
    console.error("usage: check-changelog-sync.mjs <dev|release> [--base-ref <ref>]");
    process.exit(2);
  }
}

// Only run the CLI when executed directly (not when imported by tests).
// pathToFileURL handles spaces/non-ASCII in paths — a plain template-string
// comparison would silently skip main() (fail OPEN) on such paths.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::CHANGELOG check crashed: ${err.message}`);
    process.exit(1);
  });
}
