import { BskyAgent } from "@atproto/api";
import {
  blueskyService,
  getBlueskyCredentials,
  normalizeBlueskyHandle,
  rememberBlueskyDid,
} from "./integrations";

/**
 * One place to get a logged-in Bluesky agent.
 *
 * Every Bluesky call site used to do its own `login()` — four times in
 * `bluesky-graph.ts` alone — so a single sync did several full createSession
 * round-trips before it did any work.
 *
 * Two entry points, because call sites genuinely want different things when
 * credentials are missing: the scheduled sweeps treat Bluesky as optional and
 * return a zero result, while admin actions want an error the owner can see —
 * silently doing nothing there looks like success.
 *
 * Credentials come from `getBlueskyCredentials()`, not `process.env`: they may
 * be stored in the database, encrypted at rest, with the environment as a
 * fallback (#326). Reading the env directly would ignore anything set from the
 * admin panel.
 */

/**
 * How long a cached session is reused. Access tokens last ~2h, so this is a
 * conservative fraction — long enough to collapse a whole sync into one login,
 * short enough that we never hand out a token near expiry.
 */
const SESSION_TTL_MS = 30 * 60_000;

let cached: { key: string; at: number; agent: BskyAgent } | null = null;
let inFlight: { key: string; p: Promise<BskyAgent> } | null = null;

/** Are Bluesky credentials configured at all? */
export async function blueskyConfigured(): Promise<boolean> {
  return (await getBlueskyCredentials()) !== null;
}

/**
 * A logged-in agent, or `null` when Bluesky isn't configured.
 *
 * For callers that treat Bluesky as optional — the scheduler's sweeps and the
 * pollers, which return a zero result and carry on.
 */
export async function getBlueskyAgent(): Promise<BskyAgent | null> {
  const creds = await getBlueskyCredentials();
  if (!creds) return null;

  const handle = normalizeBlueskyHandle(creds.handle);

  // Keyed on the credentials themselves, so rotating them invalidates the
  // session rather than silently reusing the old identity.
  // The DID is the stable identifier; the handle is a mutable alias that stops
  // resolving the moment the owner points it at their own domain (#448).
  const identifier = creds.did ?? handle;

  // The SERVICE is part of the key (#449). Without it, pointing the instance at a
  // different PDS would hand back a cached agent still logged in to the old one —
  // and it would keep working, so the symptom is posts going to the wrong host
  // rather than an error anyone would notice.
  const service = await blueskyService();
  const key = `${service}|${identifier}:${creds.password}`;
  if (cached && cached.key === key && Date.now() - cached.at < SESSION_TTL_MS) {
    return cached.agent;
  }

  // Collapse concurrent callers onto one login instead of racing several.
  //
  // KEYED, and that is not decoration (#541). This used to be a bare promise
  // with no record of what it was logging in AS. A caller arriving with
  // different credentials while a login was in flight skipped its own and was
  // handed the other one's agent — logged in to the wrong identity, or the wrong
  // PDS, and working, so the symptom is posts going somewhere unexpected rather
  // than an error. Narrow, but this change routes twelve more callers onto this
  // path, and the whole point of those callers moving here is that the service
  // is now variable.
  if (!inFlight || inFlight.key !== key) {
    const p = (async () => {
      const agent = new BskyAgent({ service });
      await agent.login({ identifier, password: creds.password });
      // Capture it lazily, so an instance configured entirely by environment
      // still gains the safety net without ever visiting the admin panel.
      if (!creds.did && agent.session?.did) void rememberBlueskyDid(agent.session.did);
      cached = { key, at: Date.now(), agent };
      return agent;
    })().finally(() => {
      // Only clear if it is still OURS — a later caller with a different key may
      // have replaced it, and clearing that one would strand its awaiters.
      if (inFlight?.p === p) inFlight = null;
    });
    inFlight = { key, p };
  }

  try {
    return await inFlight.p;
  } catch (err) {
    // Never leave a failed login cached — the next caller should retry.
    cached = null;
    throw err;
  }
}

/**
 * A logged-in agent, or a thrown error when Bluesky isn't configured.
 *
 * For callers that surface the failure to the owner.
 */
export async function requireBlueskyAgent(): Promise<BskyAgent> {
  const agent = await getBlueskyAgent();
  if (!agent) throw new Error("Bluesky credentials not configured");
  return agent;
}

/** Drop the cached session. For tests, and for anything that rotates credentials. */
export function resetBlueskyAgent(): void {
  cached = null;
  inFlight = null;
}
