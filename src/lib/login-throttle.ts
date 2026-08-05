import { makeRateLimiter } from "./oauth";
import { SHARED_BUCKET_KEY } from "./client-ip";

/**
 * Throttling for the admin login, and the ONLY implementation of it (#531).
 *
 * **The bug.** On the default configuration `rateLimitKey` returns the same
 * string for everybody — there is no trusted proxy header, so no caller can be
 * told from another. The login route then locked that one key after 5 failures
 * a minute. So an unauthenticated caller could hold the owner out of their own
 * admin panel indefinitely for about five requests a minute, and the 429 was
 * returned before the password was even looked at, so a correct password was
 * rejected exactly like a wrong one.
 *
 * **Why there is no clean answer, and this is worth being honest about.** On a
 * shared bucket the two goals genuinely conflict: a per-caller limit protects
 * the owner from an attacker's failures, and a shared limit turns one caller's
 * failures into everybody's. Neither keying alone satisfies both. `NextRequest`
 * exposes no peer address in Next 16, so there is no unforgeable fallback to
 * reach for either — verified, not assumed.
 *
 * **So the tiers are split by what the key actually means:**
 *
 *  - **A real per-caller key** (the operator set `TRUSTED_PROXY_HEADER`, #515)
 *    gets the strict 5/60s limit. This is the tier that does real work: one
 *    caller's failures never touch another's budget.
 *  - **The shared key** is deliberately NOT given a per-caller limit, because
 *    that is precisely the lockout. It falls to the global tier only.
 *  - **The global tier** applies always, as the backstop that needs no
 *    configuration. 20 failures per 5 minutes.
 *
 * **Why 20/5min and not the 50/15min the issue suggests.** 50 per 15 minutes is
 * 3.3 requests a minute — *cheaper* to sustain than today's 5 per minute, so it
 * would make the unconfigured case slightly worse rather than better. What
 * actually helps an owner with no per-caller key is the window, not the count: a
 * lockout that lifts in five minutes is an annoyance, one that never lifts is a
 * lockout. 20 is far above anything an honest owner reaches.
 *
 * **The reserved key cannot be reached, and that is not theoretical.** The same
 * two-tier design on the private instance had a live hole: a second limiter
 * implementation wrote bare keys into the same store as a reserved `global` row,
 * so a caller who could influence the key sent `global` as their address,
 * reached that row through the per-caller path, and a fresh window there reset
 * the count — clearing a lockout in progress.
 *
 * Being precise about what stops it here, because the two are not equal. The
 * tiers are **separate limiter instances with separate Maps**, so there is no
 * shared row to collide on — that is the real defence, and it is the thing the
 * private instance lacked. The `ip:` prefix below is the belt: it keeps the
 * property true if the two are ever merged into one store, which is exactly the
 * refactor that opened the hole there.
 *
 * **This module is the only implementation, and a test enforces that.** A
 * behavioural test cannot catch "a second copy of this exists somewhere else",
 * which is exactly how that hole was opened. A source sweep can.
 *
 * **In-process, deliberately.** The private instance backs this with a database
 * table; that is not ported. It would add a schema change for an availability
 * issue, and a shared store is what made the key collision exploitable there.
 * The cost is that a restart clears the counters — which is also the only escape
 * hatch a locked-out owner has today, so it is not purely a loss. See
 * `scripts/reset-login-throttle.ts`.
 */

/** Strict, and only ever applied to a key that identifies one caller. */
const PER_CALLER_MAX = 5;
const PER_CALLER_WINDOW_MS = 60_000;

/** The configuration-free backstop. Short window so a lockout lifts by itself. */
const GLOBAL_MAX = 20;
const GLOBAL_WINDOW_MS = 5 * 60_000;

/**
 * Bare, and unreachable from the per-caller namespace below. See the note about
 * the collision above — this is the row an attacker would want to address.
 */
const GLOBAL_KEY = "global";

const perCaller = makeRateLimiter(PER_CALLER_MAX, PER_CALLER_WINDOW_MS);
const globalWall = makeRateLimiter(GLOBAL_MAX, GLOBAL_WINDOW_MS);

/**
 * Namespace every caller-derived key. The prefix is the whole defence: no value
 * a caller can put in a header will ever collide with `GLOBAL_KEY`, because
 * everything from a caller starts with `ip:` and `GLOBAL_KEY` does not.
 */
const callerKey = (key: string) => `ip:${key}`;

/** Whether this key names one caller, or is the everybody-shares-it fallback. */
const identifiesACaller = (key: string) => key !== SHARED_BUCKET_KEY;

let warnedShared = false;

/** Which tier is refusing, if any. Counts nothing — see `makeRateLimiter.peek`. */
export type LoginBlock = "per-caller" | "global" | null;

export function loginBlockedBy(key: string, now: number = Date.now()): LoginBlock {
  if (identifiesACaller(key) && !perCaller.peek(callerKey(key), now)) return "per-caller";
  if (!globalWall.peek(GLOBAL_KEY, now)) return "global";
  return null;
}

/**
 * Count a REAL password failure.
 *
 * Only ever called after a password has been examined and found wrong. A
 * malformed body or a non-string password returns earlier and reaches neither
 * counter — otherwise anyone could lock the owner out with empty POSTs that cost
 * the server nothing, which is the same attack with a smaller bill.
 */
export function recordLoginFailure(key: string, now: number = Date.now()): void {
  if (identifiesACaller(key)) perCaller.check(callerKey(key), now);
  globalWall.check(GLOBAL_KEY, now);
}

/** A correct password clears both tiers — the caller has proved who they are. */
export function clearLoginAttempts(key: string): void {
  perCaller.reset(callerKey(key));
  globalWall.reset(GLOBAL_KEY);
}

/**
 * Say once, in the log, that this instance can't tell its visitors apart.
 *
 * It lands in the support bundle's log tail (#490), which is where an owner
 * wondering why they were briefly locked out will actually look — and it names
 * the setting that fixes it rather than leaving them to find #515.
 */
export function warnIfSharedBucket(key: string): void {
  if (warnedShared || identifiesACaller(key)) return;
  warnedShared = true;
  console.warn(
    "[login] No trusted proxy header is configured, so every visitor shares one " +
      "rate-limit bucket and a stranger's failed logins count against yours. Set " +
      "TRUSTED_PROXY and TRUSTED_PROXY_HEADER to whichever header your proxy " +
      "OVERWRITES — see docs/configuration.md. Until then the admin login falls " +
      `back to a global limit of ${GLOBAL_MAX} failures per ${GLOBAL_WINDOW_MS / 60_000} minutes.`,
  );
}
