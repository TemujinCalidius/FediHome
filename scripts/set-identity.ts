// @ts-nocheck — one-off maintenance script (run via tsx, not type-checked)
/**
 * Repair a wrong SITE_URL (or handle/domain) on an instance that has already
 * published (#447).
 *
 * WHY THIS EXISTS. `POST /api/admin/identity` refuses once the instance has
 * published an item, gained a follower, or followed anyone — and that refusal is
 * correct. The address is baked into `@unique` absolute URLs that remote servers
 * cached long ago, so changing it ORPHANS that content rather than moving it.
 * This script is not a way around that. It is a way to CHOOSE it knowingly,
 * which is the right trade when the wrong URL was set very early and the handful
 * of affected posts are acceptable losses.
 *
 * WHY A SCRIPT AND NOT A FILE EDIT. Editing `.env.local` is the usual advice and
 * it does not survive on a PaaS — the filesystem is rebuilt on every deploy, so
 * the fix silently reverts. This writes the `identity.*` override to the
 * DATABASE, which is the only durable place on those platforms. It is also the
 * population most likely to be stuck: PaaS owners rarely have a persistent
 * shell, but they do get one-off command runners (`railway run`, `fly ssh
 * console`, `heroku run`) and they always have logs.
 *
 * The real answer is #347 (Move + alsoKnownAs), which migrates instead of
 * orphaning. This is the stopgap for people stuck today.
 *
 *   npx tsx scripts/set-identity.ts                      # show current values
 *   npx tsx scripts/set-identity.ts --site-url https://example.com
 *   npx tsx scripts/set-identity.ts --site-url https://example.com --orphan-published
 *   npx tsx scripts/set-identity.ts --site-url ""        # clear, fall back to env
 *
 * Restart the app afterwards: overrides load once at boot (src/instrumentation.ts).
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const KEY_PREFIX = "identity.";
const FIELDS = { "site-url": "siteUrl", "fedi-handle": "fediHandle", "fedi-domain": "fediDomain" };

/** `--flag value` and `--flag=value`, plus bare `--flag` for booleans. */
function parseArgs(argv: string[]): Record<string, string | true> {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

/**
 * Deliberately a COPY of the counts in identityIsLocked(), not an import.
 *
 * The library version reads `getSiteUrl()` transitively through the identity
 * overlay, and this script's whole job is to run when that overlay is wrong.
 * Duplicating eight counts is a smaller cost than a script that fails for the
 * same reason the operator is running it. If a lockable category is added, this
 * under-reports — which is why it prints the numbers rather than just a verdict.
 */
async function describeLock() {
  const [posts, photos, videos, audio, dms, outgoing, followers, following] = await Promise.all([
    prisma.post.count({ where: { apId: { not: null } } }),
    prisma.photo.count({ where: { apId: { not: null } } }),
    prisma.video.count({ where: { apId: { not: null } } }),
    prisma.audio.count({ where: { apId: { not: null } } }),
    prisma.directMessage.count({ where: { isOutgoing: true } }),
    prisma.fediPost.count({ where: { isOutgoing: true } }),
    prisma.fediFollower.count(),
    prisma.fediFollowing.count(),
  ]);
  const published = posts + photos + videos + audio + dms + outgoing;
  return { published, followers, following, locked: published > 0 || followers > 0 || following > 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = await prisma.siteSetting.findMany({
    where: { key: { in: Object.values(FIELDS).map((f) => KEY_PREFIX + f) } },
  });
  const currentMap = Object.fromEntries(current.map((r) => [r.key, r.value]));

  console.log("\nStored identity overrides (database — these outrank the environment):");
  for (const field of Object.values(FIELDS)) {
    const key = KEY_PREFIX + field;
    console.log(`  ${field.padEnd(11)} ${currentMap[key] ?? "(not set — using the environment)"}`);
  }
  console.log("\nEnvironment:");
  console.log(`  SITE_URL    ${process.env.SITE_URL ?? "(unset)"}`);

  const patch = {};
  for (const [flag, field] of Object.entries(FIELDS)) {
    if (args[flag] !== undefined) patch[field] = args[flag] === true ? "" : String(args[flag]);
  }

  if (Object.keys(patch).length === 0) {
    console.log("\nNothing to change. Pass --site-url, --fedi-handle or --fedi-domain to set one.");
    console.log('Pass an empty value (--site-url "") to clear an override and fall back to the environment.\n');
    return;
  }

  // Validate before reporting the lock, so an obvious typo is caught without the
  // operator first reading a wall of text about orphaning content.
  if (patch.siteUrl) {
    let u;
    try {
      u = new URL(patch.siteUrl);
    } catch {
      throw new Error(`--site-url must be an absolute URL including the scheme. Got: ${patch.siteUrl}`);
    }
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      throw new Error(`--site-url must be https for a real host. Got: ${u.protocol}//`);
    }
    if (u.pathname !== "/" || u.search || u.hash) {
      throw new Error(`--site-url must be an origin with no path, query or fragment. Got: ${patch.siteUrl}`);
    }
  }

  const lock = await describeLock();
  if (lock.locked) {
    console.log("\n" + "=".repeat(72));
    console.log("THIS INSTANCE IS PUBLISHED. Changing its address ORPHANS content.");
    console.log("=".repeat(72));
    if (lock.published > 0) {
      console.log(`  ${lock.published} published item(s) carry the current address inside them.`);
      console.log("    Remote servers keep the first address they saw. Those items do not move;");
      console.log("    they simply stop resolving. Replies and boosts on them are lost with them.");
    }
    if (lock.followers > 0) {
      console.log(`  ${lock.followers} account(s) follow you at the current address.`);
      console.log("    Their servers deliver to it. They will not be told, and will not see a break —");
      console.log("    your posts just stop arriving.");
    }
    if (lock.following > 0) {
      console.log(`  ${lock.following} account(s) you follow recorded your current address.`);
      console.log("    They keep delivering to an address that no longer resolves, so your timeline");
      console.log("    quietly empties while your Following list still says everything is fine.");
    }
    console.log("\n  A proper migration (Move + alsoKnownAs, #347) moves followers instead of");
    console.log("  orphaning them. This script does NOT do that.");

    if (args["orphan-published"] !== true) {
      console.log("\nRefusing to continue. If those losses are acceptable — usually true only when");
      console.log("the wrong address was set very early — re-run with --orphan-published.\n");
      process.exitCode = 1;
      return;
    }
    console.log("\n--orphan-published given. Proceeding.\n");
  }

  for (const [field, raw] of Object.entries(patch)) {
    const key = KEY_PREFIX + field;
    if (raw.trim() === "") {
      await prisma.siteSetting.deleteMany({ where: { key } });
      console.log(`  cleared ${field} (will fall back to the environment)`);
      continue;
    }
    // Normalised the same way identity-store does: lowercase host, no trailing
    // slash. A capital letter in a domain made the instance invisible (#427),
    // and this script must not be a way to reintroduce that.
    let value = raw.trim();
    if (field === "siteUrl") {
      const u = new URL(value);
      u.hostname = u.hostname.toLowerCase();
      value = u.origin;
    } else {
      value = value.toLowerCase();
    }
    await prisma.siteSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    console.log(`  set ${field} = ${value}`);
  }

  console.log("\nDone. RESTART THE APP — identity overrides are read once at boot.\n");
}

main()
  .catch((e) => {
    console.error("\n" + (e?.message || e) + "\n");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
