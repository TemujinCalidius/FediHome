import { getIdentity, getConfiguredSiteUrl } from "./identity";
import { isLocalOrPrivateHost } from "./public-host";

/**
 * Boot-time guards (#357, #362).
 *
 * These run once from `src/instrumentation.ts`, AFTER the database identity
 * overlay has loaded — otherwise a perfectly good DB-configured identity would
 * be judged on the environment alone.
 */

/** Set to `true` to boot with an unreachable identity anyway (local testing). */
const OPT_OUT = "FEDIHOME_ALLOW_LOCAL_IDENTITY";

export class UnusableIdentityError extends Error {}

/**
 * Refuse to start in production with an identity the Fediverse can't reach.
 *
 * Without `SITE_URL`, `getIdentity()` falls back to `http://localhost:3000` and
 * the handle to `me`, and the instance federates as `@me@localhost:3000` —
 * silently. That address is written into the actor id, the WebFinger subject,
 * the signature keyId, and (because `Post.apId` is absolute) into every post
 * published before it's noticed. Correcting the environment afterwards does not
 * fix any of it: remote servers keep the identity they first saw, and FediHome
 * has no outbound `Move` yet (#347).
 *
 * The setup wizard has guarded against exactly this since #326 — but the one
 * install path that SKIPS the wizard is the one with no protection. `install.sh`
 * writes `ADMIN_SECRET` before first boot, which makes `proxy.ts` lock `/setup`
 * out entirely. Same for any container deploy.
 *
 * **Failing closed is the point.** An instance that refuses to start is a
 * two-minute fix; one that boots with the wrong identity is not fixable at all.
 */
export function assertUsableIdentity(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env[OPT_OUT] === "true") {
    console.warn(
      `[FediHome] ${OPT_OUT}=true — booting with a local/private identity on purpose. ` +
        `Anything published now carries an address the Fediverse can't reach.`,
    );
    return;
  }

  const configured = getConfiguredSiteUrl();
  const { siteUrl, fediAddress } = getIdentity();

  const problem = !configured
    ? "SITE_URL is not set"
    : isLocalOrPrivateHost(new URL(siteUrl).hostname)
      ? `SITE_URL is ${siteUrl}, which the Fediverse can't reach`
      : null;

  if (!problem) return;

  throw new UnusableIdentityError(
    [
      "",
      "  ✗ FediHome refused to start: no usable public address.",
      "",
      `    ${problem}.`,
      `    This instance would federate as ${fediAddress}.`,
      "",
      "    That address is baked into your ActivityPub identity and into every",
      "    post you publish, and it CANNOT be corrected afterwards — other",
      "    servers keep the first address they saw.",
      "",
      "    Fix: set SITE_URL to your real public address, e.g.",
      "      SITE_URL=https://yourdomain.com",
      "",
      `    Only testing locally? Set ${OPT_OUT}=true to boot anyway.`,
      "",
    ].join("\n"),
  );
}

/**
 * Mark setup complete once an instance is genuinely configured (#362).
 *
 * `SiteSettings.setupDone` is only ever set by the setup wizard — but a headless
 * install (`install.sh`, or any container) writes `ADMIN_SECRET` before first
 * boot, which makes `proxy.ts` redirect `/setup` away. On that path the wizard
 * can never run, so the flag stays `false` forever.
 *
 * That's not just untidy. `looksEstablished()` in `federation.ts` reads exactly
 * one thing besides it — the follower count — to decide whether a missing
 * `ActorKeys` row is a fresh bootstrap or a lost identity (#310). With
 * `setupDone` permanently false, a Bluesky-only or RSS-only instance is treated
 * as brand new indefinitely, and losing the keypair regenerates it **silently**.
 *
 * Only called once `assertUsableIdentity()` has passed, so "configured" means a
 * real public identity — not merely that the process started.
 *
 * Never throws: this is a correctness nicety, not a reason to fail a boot.
 */
export async function markSetupCompleteIfConfigured(): Promise<void> {
  if (!process.env.ADMIN_SECRET) return; // still genuinely mid-setup
  if (!getConfiguredSiteUrl()) return;

  try {
    const { prisma } = await import("./db");
    const existing = await prisma.siteSettings.findUnique({
      where: { id: "main" },
      select: { setupDone: true },
    });
    if (existing?.setupDone) return; // already recorded, nothing to do

    await prisma.siteSettings.upsert({
      where: { id: "main" },
      create: { id: "main", setupDone: true },
      update: { setupDone: true },
    });
    console.warn(
      "[FediHome] Recorded setup as complete (configured headlessly, so the wizard never ran) — " +
        "the federation-identity safety check in #310 is now active.",
    );
  } catch {
    // A DB hiccup here costs a warning we'd have liked, not a working boot.
  }
}
