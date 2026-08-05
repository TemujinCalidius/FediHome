import { setSecrets } from "./log-buffer";

/**
 * Resolve every credential this instance actually uses, so the log tail can be
 * scrubbed against them (#490).
 *
 * THE TRAP THIS EXISTS TO AVOID, stated plainly because the wrong version of
 * this file looks identical and passes its tests:
 *
 * Since #59 the DATABASE is the primary store for every integration credential,
 * and the environment is only a fallback. On any instance configured through the
 * admin panel — the documented path, and what the demo uses —
 * `process.env.BLUESKY_APP_PASSWORD` is UNSET. So a redactor built by scrubbing
 * `process.env` removes NOTHING, and a leak test that plants environment
 * sentinels passes green while the real password walks straight through.
 *
 * No pattern catches it either. A Bluesky app password is `xxxx-xxxx-xxxx-xxxx`
 * — 19 characters, lowercase and dashes. Not 32-hex, not 40+ base64, not a JWT,
 * not preceded by `password=`.
 *
 * So this calls the SAME resolvers the app calls, which decrypt the database
 * rows, and treats the environment as a second pass rather than the only one.
 *
 * Every lookup is settled independently: one integration whose row is
 * undecryptable (ADMIN_SECRET changed) must not cost the redaction set the other
 * four. A resolver that throws contributes nothing and is not fatal — the same
 * bias the bundle itself takes.
 *
 * That tolerance is also why the module imports below are hoisted out of the
 * parallel block. A silently-empty resolver is indistinguishable here from a
 * genuinely-unconfigured integration, so anything that can make one look like
 * the other has to be removed rather than caught.
 */

/** Environment variables whose VALUE is a secret. Names alone are harmless. */
const SECRET_ENV = [
  "ADMIN_SECRET",
  "ADMIN_PASSWORD",
  // The whole URL, because it embeds the password — and the password on its own
  // too, below, since a Prisma error can print either.
  "DATABASE_URL",
  "BLUESKY_APP_PASSWORD",
  "THREADS_ACCESS_TOKEN",
  "SMTP_PASS",
  "VAPID_PRIVATE_KEY",
  "TINYLYTICS_API_KEY",
] as const;

/** The password out of a Postgres URL, which is the part that leaks on its own. */
function databaseUrlPassword(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const pw = new URL(url).password;
    return pw ? decodeURIComponent(pw) : null;
  } catch {
    return null;
  }
}

/**
 * Every secret value this process can currently resolve.
 *
 * Exported for the test that plants DB-stored sentinels — an env-only test is
 * precisely the one that would have shipped the bug this file is about.
 */
export async function resolveSecrets(): Promise<string[]> {
  const found: string[] = [];

  // Imported lazily — these modules pull in Prisma and the crypto box, and a
  // redaction refresh must not be able to fail a boot.
  //
  // Each module is imported ONCE, before the resolvers run. Firing three
  // concurrent `import("./integrations")` calls inside the Promise.allSettled
  // below silently produced a half-populated namespace for two of the three:
  // getBlueskyCredentials resolved, getThreadsCredentials and
  // getDayOneCredentials came back undefined, and `?? null` turned that into
  // "no such credential" rather than an error. Two credentials would have gone
  // un-redacted with nothing anywhere to say so.
  const [integrations, pushConfig, analytics] = await Promise.all([
    import("./integrations").catch(() => null),
    import("./push-config").catch(() => null),
    import("./analytics-secret").catch(() => null),
  ]);

  // Settled independently: one integration whose row won't decrypt
  // (ADMIN_SECRET changed) must not cost the redaction set the other four.
  //
  // Each wrapped in an async IIFE, not called inline. `Promise.allSettled` only
  // catches REJECTIONS — a synchronous throw while the array is being built
  // escapes it and takes the whole refresh with it, which for the bundle means a
  // 500 rather than four credentials still being redacted.
  const results = await Promise.allSettled([
    (async () => (await integrations?.getBlueskyCredentials())?.password ?? null)(),
    (async () => (await integrations?.getThreadsCredentials())?.accessToken ?? null)(),
    (async () => (await integrations?.getDayOneCredentials())?.pass ?? null)(),
    (async () => (await pushConfig?.getVapidConfig())?.privateKey ?? null)(),
    (async () => (await analytics?.getTinylyticsApiKey()) ?? null)(),
  ]);
  for (const r of results) {
    if (r.status === "fulfilled" && typeof r.value === "string" && r.value) found.push(r.value);
  }

  // The environment as a SECOND pass, never the only one. An instance configured
  // entirely by env vars is a real configuration and its values matter too — the
  // bug is treating this list as sufficient, not including it.
  for (const name of SECRET_ENV) {
    const v = process.env[name];
    if (v) found.push(v);
  }
  const dbPw = databaseUrlPassword(process.env.DATABASE_URL);
  if (dbPw) found.push(dbPw);

  return found;
}

/**
 * Re-resolve and install the redaction snapshot the capture path scrubs against.
 *
 * Called at boot and again before the bundle is assembled. Between those, a
 * credential changed in the admin panel is not yet in the snapshot — which is
 * exactly why the bundle also runs a final pass with a freshly-resolved set
 * rather than trusting what was scrubbed on the way in.
 */
export async function refreshRedactionSet(): Promise<number> {
  const secrets = await resolveSecrets();
  setSecrets(secrets);
  return secrets.length;
}
