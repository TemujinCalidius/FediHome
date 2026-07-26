/**
 * What build is this, exactly? (#358, #361)
 *
 * `package.json` version alone can't answer it: releases are cut periodically
 * while `dev` moves continuously, so "1.19.0" covers a wide range of actual
 * code. And nothing inside a container can work it out for itself — the image
 * has no `.git` (excluded by `.dockerignore`), which is also why
 * `check-updates` silently gave up there.
 *
 * The SHA is baked in at image build time via a build arg. Outside a container
 * we fall back to the checkout's own git SHA, and to the marker `update.sh`
 * writes after a successful build.
 */
import { execSync } from "child_process";
import { readFileSync } from "fs";

let cached: string | null | undefined;

/** The commit this build came from, or null when it genuinely can't be known. */
export function buildSha(): string | null {
  if (cached !== undefined) return cached;
  cached = resolve();
  return cached;
}

function resolve(): string | null {
  // 1. Baked in at image build time — the only option inside a container.
  const baked = process.env.FEDIHOME_BUILD_SHA?.trim();
  if (baked) return baked;

  // 2. The marker update.sh writes after a successful build.
  try {
    const marker = readFileSync(".fedihome-built-sha", "utf-8").trim();
    if (marker) return marker;
  } catch {
    /* not present */
  }

  // 3. A live git checkout.
  try {
    const sha = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha) return sha;
  } catch {
    /* not a checkout */
  }

  return null;
}

/** Short form for display. */
export function shortSha(): string | null {
  const s = buildSha();
  return s ? s.slice(0, 7) : null;
}
