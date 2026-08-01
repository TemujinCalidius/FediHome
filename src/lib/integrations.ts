import { prisma } from "./db";
import { encryptSecret, decryptSecret } from "./secret-box";

/**
 * Crosspost integration credentials (Bluesky, Threads), configurable in the
 * admin panel so no server/file access is needed (#59). Secrets — the Bluesky
 * app password and the Threads access token — are stored AES-256-GCM-encrypted
 * (see secret-box, key derived from ADMIN_SECRET); the non-secret handle / user
 * id are stored plain.
 *
 * Stored as `SiteSetting` rows under the `integration.*` namespace, DELIBERATELY
 * NOT part of `SITE_CONFIG_KEYS` — so they're never returned by the site-config
 * admin GET nor writable via `applySiteConfig`. Access is ONLY through this
 * module + the dedicated /api/admin/integrations route, which never returns a
 * secret to the client.
 *
 * Reads fall back to the legacy env vars (BLUESKY_* / THREADS_*), so instances
 * configured the old way keep working unchanged. A saved DB credential takes
 * precedence over the env var.
 */

/**
 * The AT Protocol host FediHome talks to.
 *
 * One constant rather than the string repeated across a dozen call sites — it was
 * copy-pasted into every module that builds a `BskyAgent`. AT Protocol is
 * deliberately multi-host, so this becomes configurable in #449; collapsing it
 * here first means that change is one edit rather than twelve.
 *
 * Lives in this module because it sits at the bottom of the import graph:
 * `bluesky-agent.ts` imports from here, not the other way round.
 */
export const BLUESKY_SERVICE = "https://bsky.social";

const KEYS = {
  bskyHandle: "integration.bluesky.handle",
  bskyPassword: "integration.bluesky.password", // encrypted
  bskyDid: "integration.bluesky.did", //           captured at login, not a secret
  threadsUserId: "integration.threads.userId",
  threadsToken: "integration.threads.accessToken", // encrypted
  smtpHost: "integration.smtp.host",
  smtpPort: "integration.smtp.port",
  smtpUser: "integration.smtp.user",
  smtpPass: "integration.smtp.password", // encrypted
  dayOneEmail: "integration.dayone.email",
} as const;

async function readRows(keys: string[]): Promise<Record<string, string>> {
  try {
    const found = await prisma.siteSetting.findMany({ where: { key: { in: keys } } });
    return Object.fromEntries(found.map((r) => [r.key, r.value]));
  } catch {
    return {}; // DB down/mid-migration → fall back to env
  }
}
async function put(key: string, value: string): Promise<void> {
  await prisma.siteSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}
async function drop(keys: string[]): Promise<void> {
  await prisma.siteSetting.deleteMany({ where: { key: { in: keys } } });
}

/* ------------------------------- Bluesky ------------------------------- */
export interface BlueskyCredentials {
  handle: string;
  password: string;
  /**
   * The account's DID, captured at login — the stable identifier.
   *
   * The handle is a MUTABLE ALIAS in AT Protocol; the DID is what follows,
   * followers and posts are actually recorded against. So the moment an owner
   * points their Bluesky handle at their own domain (#448), the stored handle
   * stops being a working login identifier — while the DID keeps working
   * forever. Logging in by DID is what stops a handle change quietly breaking
   * crossposting, and the breakage would otherwise surface half an hour later,
   * when the cached session expires, looking entirely unrelated.
   *
   * Optional because an env-configured instance has never logged in through the
   * admin panel. Every call site falls back to the handle, so those behave
   * exactly as before until the DID is captured lazily on first login.
   */
  did?: string;
}

/**
 * Canonicalise a Bluesky handle (#257): strip a leading `@` (users very commonly
 * paste `@name.bsky.social`), trim, and lowercase. `@atproto`'s `login()` treats
 * a leading `@` as an empty-local-part email → `InvalidEmail`, so a raw `@handle`
 * would otherwise fail to connect. Applied on every test + save.
 */
export function normalizeBlueskyHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Resolved Bluesky credentials: DB (decrypted) first, else the env vars.
 *
 * Normalizes on READ (#257), not just on write. Every caller feeds `handle`
 * straight into `agent.login()`, so a raw `@handle` from either source fails
 * with `InvalidEmail` — silently, since most callers are background jobs
 * (crosspost, polls). Both branches need it: `BLUESKY_HANDLE` is never
 * normalized at all, and DB rows written before #258 were stored raw with no
 * migration to backfill them. Normalizing here covers every call site at once.
 */
export async function getBlueskyCredentials(): Promise<BlueskyCredentials | null> {
  const o = await readRows([KEYS.bskyHandle, KEYS.bskyPassword, KEYS.bskyDid]);
  if (o[KEYS.bskyHandle] && o[KEYS.bskyPassword]) {
    const password = decryptSecret(o[KEYS.bskyPassword]);
    if (password) {
      return {
        handle: normalizeBlueskyHandle(o[KEYS.bskyHandle]),
        password,
        did: o[KEYS.bskyDid] || undefined,
      };
    }
  }
  const eh = process.env.BLUESKY_HANDLE;
  const ep = process.env.BLUESKY_APP_PASSWORD;
  // The DID row is read even on the env path: it is captured lazily at login, so
  // an instance configured entirely by environment still gains the safety net.
  return eh && ep
    ? { handle: normalizeBlueskyHandle(eh), password: ep, did: o[KEYS.bskyDid] || undefined }
    : null;
}

export async function setBlueskyCredentials(
  handle: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const enc = encryptSecret(password);
  if (!enc) return { ok: false, error: "Encryption unavailable — ADMIN_SECRET is not set." };
  await put(KEYS.bskyHandle, normalizeBlueskyHandle(handle));
  await put(KEYS.bskyPassword, enc);
  // Any previously captured DID belongs to the account we just replaced.
  await drop([KEYS.bskyDid]);
  return { ok: true };
}

export async function clearBlueskyCredentials(): Promise<void> {
  await drop([KEYS.bskyHandle, KEYS.bskyPassword, KEYS.bskyDid]);
}

/** Try an app-password login without storing anything — for the "Test" button. */
export async function testBlueskyLogin(
  handle: string,
  password: string,
): Promise<{ ok: boolean; error?: string; did?: string }> {
  try {
    const { BskyAgent } = await import("@atproto/api");
    const agent = new BskyAgent({ service: BLUESKY_SERVICE });
    await agent.login({ identifier: normalizeBlueskyHandle(handle), password });
    // The session carries the DID. Returned so the caller can persist it —
    // it is the only identifier that survives a handle change (#448).
    return { ok: true, did: agent.session?.did };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "login failed" };
  }
}

/** Persist the DID captured at login. Best-effort — never breaks a working login. */
export async function rememberBlueskyDid(did: string): Promise<void> {
  if (!did.startsWith("did:")) return;
  try {
    await put(KEYS.bskyDid, did);
  } catch {
    /* the handle still works as an identifier; this is the safety net, not the path */
  }
}

/* ------------------------------- Threads ------------------------------- */
export interface ThreadsCredentials {
  accessToken: string;
  userId: string;
}

export async function getThreadsCredentials(): Promise<ThreadsCredentials | null> {
  const o = await readRows([KEYS.threadsUserId, KEYS.threadsToken]);
  if (o[KEYS.threadsUserId] && o[KEYS.threadsToken]) {
    const accessToken = decryptSecret(o[KEYS.threadsToken]);
    if (accessToken) return { accessToken, userId: o[KEYS.threadsUserId] };
  }
  const eu = process.env.THREADS_USER_ID;
  const et = process.env.THREADS_ACCESS_TOKEN;
  return eu && et ? { accessToken: et, userId: eu } : null;
}

export async function setThreadsCredentials(
  userId: string,
  accessToken: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const enc = encryptSecret(accessToken);
  if (!enc) return { ok: false, error: "Encryption unavailable — ADMIN_SECRET is not set." };
  await put(KEYS.threadsUserId, userId);
  await put(KEYS.threadsToken, enc);
  return { ok: true };
}

export async function clearThreadsCredentials(): Promise<void> {
  await drop([KEYS.threadsUserId, KEYS.threadsToken]);
}

/** Verify a Threads token via the Graph API without storing anything. */
export async function testThreadsToken(
  userId: string,
  accessToken: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Send the token in the Authorization header, not the query string, so it
    // can't land in proxy/access logs.
    const res = await fetch(
      `https://graph.threads.net/v1.0/${encodeURIComponent(userId)}?fields=username`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body?.error?.message || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request failed" };
  }
}

/* -------------------------- DayOne journal / SMTP -------------------------- */

/**
 * Journalling by email (#326). The last credentials still read straight out of
 * `process.env` — moving them here means an SMTP password can be changed without
 * a redeploy, and gets it encrypted at rest like everything else.
 *
 * As with Bluesky and Threads: env stays as a fallback so existing installs are
 * untouched, a saved value wins, and the password never leaves this module.
 */
export interface DayOneCredentials {
  dayOneEmail: string;
  host: string;
  port: number;
  user: string;
  pass: string;
}

const DEFAULT_SMTP_PORT = 587;

function parsePort(v: string | undefined, fallback: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

export async function getDayOneCredentials(): Promise<DayOneCredentials | null> {
  const o = await readRows([KEYS.smtpHost, KEYS.smtpPort, KEYS.smtpUser, KEYS.smtpPass, KEYS.dayOneEmail]);
  if (o[KEYS.dayOneEmail] && o[KEYS.smtpHost] && o[KEYS.smtpUser] && o[KEYS.smtpPass]) {
    const pass = decryptSecret(o[KEYS.smtpPass]);
    if (pass) {
      return {
        dayOneEmail: o[KEYS.dayOneEmail],
        host: o[KEYS.smtpHost],
        port: parsePort(o[KEYS.smtpPort], DEFAULT_SMTP_PORT),
        user: o[KEYS.smtpUser],
        pass,
      };
    }
    // Undecryptable — ADMIN_SECRET changed. secret-health raises an alert
    // naming this credential; fall through to env rather than half-configuring.
  }

  const { DAYONE_EMAIL, SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT } = process.env;
  if (!DAYONE_EMAIL || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return {
    dayOneEmail: DAYONE_EMAIL,
    host: SMTP_HOST,
    port: parsePort(SMTP_PORT, DEFAULT_SMTP_PORT),
    user: SMTP_USER,
    pass: SMTP_PASS,
  };
}

export async function setDayOneCredentials(input: {
  dayOneEmail: string;
  host: string;
  port: number;
  user: string;
  pass: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const enc = encryptSecret(input.pass);
  if (!enc) return { ok: false, error: "Encryption unavailable — ADMIN_SECRET is not set." };
  await put(KEYS.dayOneEmail, input.dayOneEmail.trim());
  await put(KEYS.smtpHost, input.host.trim());
  await put(KEYS.smtpPort, String(parsePort(String(input.port), DEFAULT_SMTP_PORT)));
  await put(KEYS.smtpUser, input.user.trim());
  await put(KEYS.smtpPass, enc);
  return { ok: true };
}

export async function clearDayOneCredentials(): Promise<void> {
  await drop([KEYS.dayOneEmail, KEYS.smtpHost, KEYS.smtpPort, KEYS.smtpUser, KEYS.smtpPass]);
}

/* ---------------------- Status (never returns secrets) ---------------------- */
export interface IntegrationStatus {
  bluesky: { configured: boolean; handle: string | null; source: "db" | "env" | null };
  threads: { configured: boolean; userId: string | null; source: "db" | "env" | null };
  dayOne: {
    configured: boolean;
    dayOneEmail: string | null;
    host: string | null;
    port: number | null;
    user: string | null;
    source: "db" | "env" | null;
  };
}

export async function getIntegrationStatus(): Promise<IntegrationStatus> {
  const o = await readRows([
    KEYS.bskyHandle, KEYS.bskyPassword, KEYS.threadsUserId, KEYS.threadsToken,
    KEYS.smtpHost, KEYS.smtpPort, KEYS.smtpUser, KEYS.smtpPass, KEYS.dayOneEmail,
  ]);
  const bskyDb = !!(o[KEYS.bskyHandle] && o[KEYS.bskyPassword]);
  const bskyEnv = !!(process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD);
  const threadsDb = !!(o[KEYS.threadsUserId] && o[KEYS.threadsToken]);
  const threadsEnv = !!(process.env.THREADS_USER_ID && process.env.THREADS_ACCESS_TOKEN);
  return {
    bluesky: {
      configured: bskyDb || bskyEnv,
      // Normalized so the admin panel shows the same handle we actually log in
      // with, whichever source it came from (#257).
      handle: (() => {
        const h = o[KEYS.bskyHandle] ?? process.env.BLUESKY_HANDLE;
        return h ? normalizeBlueskyHandle(h) : null;
      })(),
      source: bskyDb ? "db" : bskyEnv ? "env" : null,
    },
    threads: {
      configured: threadsDb || threadsEnv,
      userId: o[KEYS.threadsUserId] ?? process.env.THREADS_USER_ID ?? null,
      source: threadsDb ? "db" : threadsEnv ? "env" : null,
    },
    dayOne: (() => {
      const db = !!(o[KEYS.dayOneEmail] && o[KEYS.smtpHost] && o[KEYS.smtpUser] && o[KEYS.smtpPass]);
      const env = !!(
        process.env.DAYONE_EMAIL && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
      );
      const port = o[KEYS.smtpPort] ?? process.env.SMTP_PORT;
      return {
        configured: db || env,
        dayOneEmail: o[KEYS.dayOneEmail] ?? process.env.DAYONE_EMAIL ?? null,
        host: o[KEYS.smtpHost] ?? process.env.SMTP_HOST ?? null,
        port: db || env ? parsePort(port, DEFAULT_SMTP_PORT) : null,
        user: o[KEYS.smtpUser] ?? process.env.SMTP_USER ?? null,
        source: db ? "db" : env ? "env" : null,
      };
    })(),
  };
}

/**
 * Ask Bluesky what a domain currently resolves to, and say whether it is us (#448).
 *
 * `com.atproto.identity.resolveHandle` is public and unauthenticated — it is the
 * same lookup any client performs when someone types the handle, so this answers
 * the only question that matters: *would a real user find this account?*
 *
 * Deliberately its OWN action rather than part of `getIntegrationStatus()`, which
 * is a pure database read hit on every admin page load. A network call there
 * would make the settings page exactly as available as bsky.social.
 *
 * Note this does not check that our own endpoint is reachable. A Docker or
 * tunnelled instance frequently cannot fetch its own public hostname, so a
 * self-fetch would paint healthy sites red — and Bluesky's answer is the
 * authoritative one anyway.
 */
export async function checkDomainHandle(
  domain: string,
): Promise<{ resolved: boolean; matches: boolean; did?: string; error?: string }> {
  const creds = await getBlueskyCredentials();
  if (!creds?.did) {
    return { resolved: false, matches: false, error: "No Bluesky account connected yet." };
  }
  try {
    const url = `${BLUESKY_SERVICE}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(domain)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // A 400 here is the normal "this handle doesn't resolve" answer, which is
      // what an owner sees before they change it in the Bluesky app.
      return { resolved: false, matches: false };
    }
    const data = (await res.json()) as { did?: string };
    return { resolved: !!data.did, matches: data.did === creds.did, did: data.did };
  } catch (e) {
    return {
      resolved: false,
      matches: false,
      error: e instanceof Error ? e.message : "lookup failed",
    };
  }
}
