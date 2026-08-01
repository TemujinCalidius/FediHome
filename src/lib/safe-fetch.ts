import { assertPublicHost } from "./url-guard";
import { guardedDispatcher } from "./pinned-dispatcher";

/**
 * The one place outbound requests to remote-controlled URLs follow redirects.
 *
 * **The bug this closes.** Nine outbound call sites all had the same shape:
 *
 * ```ts
 * if (!(await assertPublicHost(url))) return null;
 * const res = await fetch(url, { … });
 * ```
 *
 * `fetch()` follows redirects by default, so that validated the **first hop only**.
 * A host that passed the check could answer `302 Location: http://169.254.169.254/`
 * — or loopback, or anything on the local network — and the request went there
 * unchecked. The guard was doing exactly none of the work it looked like it was
 * doing on any URL that redirected.
 *
 * None of those URLs are ours. An actor URI arrives inside an inbox activity; a
 * signature's `keyId` is chosen by whoever signed it; an inbox comes out of a
 * fetched actor document. The cheapest entry point needs no relationship at all —
 * one signed POST to `/ap/inbox` from anywhere on the internet makes us fetch the
 * signer's key from a URL they picked.
 *
 * **Why it's a shared module and not a fix per call site.** `fedi-media.ts` already
 * got this right, and its comment says why — "Doing this on every redirect hop
 * closes the rebinding/redirect-chain SSRF (H1)". It had the correct loop while
 * eight of its neighbours didn't, because the rule lived in one function instead of
 * one module. `public-host.ts` records the same lesson from #357:
 *
 * > A rule that only *some* paths enforce is worse than no rule, because the one
 * > unguarded path is the one people hit.
 *
 * So the hop-following rule lives here, once, and every caller goes through it.
 */

/**
 * How many redirects to follow.
 *
 * A legitimate actor URL redirects once — a vanity path, a scheme upgrade. Media
 * hosts chain a little more (CDN indirection), which is why the media path passes
 * its own higher cap.
 */
export const MAX_REDIRECT_HOPS = 3;

/**
 * A refusal by policy, as opposed to a transport failure.
 *
 * Distinguished so `deliverActivity` can classify it as **permanent**. A host that
 * isn't public, or an inbox that cross-host-redirects, will still be that way in
 * ninety minutes — retrying is pure waste, and worse, an undeliverable item sitting
 * in the queue for a day and a half looks like a transient outage rather than a
 * configuration the remote isn't going to change.
 */
export class GuardedFetchError extends Error {
  /**
   * Is this refusal provable from the data alone, with no I/O?
   *
   * Only these are safe to call permanent. A cross-host redirect, a non-http(s)
   * target, a redirect loop — all decided from bytes we already hold, and none will
   * be different in ninety minutes.
   *
   * A non-public-host refusal is NOT structural, because `assertPublicHost` returns
   * `false` for "the DNS lookup failed" exactly as it does for "this resolves to
   * 127.0.0.1" — EAI_AGAIN, SERVFAIL and a resolver timeout are indistinguishable
   * from a private address. Marking those permanent would discard the activity
   * outright: `enqueueFailedDeliveries` filters permanent failures out, so no
   * FailedDelivery row is written and there is nothing to retry and nothing to see.
   * One resolver hiccup mid-fan-out would silently drop the post to that follower.
   * `blocks.ts` states the same rule for itself — "A DB error is reported as
   * non-permanent so the retry queue picks it up rather than dropping the activity
   * outright."
   */
  readonly structural: boolean;
  constructor(message: string, structural = false) {
    super(message);
    this.name = "GuardedFetchError";
    this.structural = structural;
  }
}

/**
 * Is this a refusal that retrying cannot fix?
 *
 * Deliberately narrower than "did guardedFetch throw" — see `structural`.
 */
export function isPolicyRefusal(err: unknown): boolean {
  return err instanceof GuardedFetchError && err.structural;
}

export interface GuardedFetchOptions {
  /**
   * May a redirect change the host?
   *
   * `true` for reads — actor and object URLs legitimately redirect across hosts,
   * and refusing would break real federation.
   *
   * `false` for writes. Nothing in ActivityPub needs a delivery to follow a
   * cross-host redirect, and allowing one hands any peer a way to make us emit a
   * request — a **validly signed** one, on the signed path — aimed at a host of
   * their choosing. Same-host redirects still work, which covers the realistic
   * case of an inbox changing path or upgrading scheme.
   */
  crossOrigin: boolean;
  /** Named in thrown errors, so a log line says which caller refused. */
  label: string;
  timeoutMs: number;
  maxHops?: number;
  /**
   * Per-hop request init. A function, not a value, because the signed callers must
   * **re-sign** for each hop: an HTTP signature covers `(request-target)` and
   * `host`, so a signature minted for hop 1 is rejected by hop 2.
   */
  init?: RequestInit | ((target: string) => RequestInit | Promise<RequestInit>);
}

/**
 * Fetch `url`, following redirects manually and re-validating **every** hop.
 *
 * Throws on any policy violation — a non-public host, a non-http(s) target, a
 * disallowed cross-host hop, or too many redirects. Callers already wrap these in
 * try/catch and degrade to `null`, so a throw lands where the old
 * `assertPublicHost` early-return did.
 *
 * A 3xx with no `Location` is returned as-is rather than treated as an error;
 * that's the remote being odd, not a policy failure.
 */
export async function guardedFetch(url: string, opts: GuardedFetchOptions): Promise<Response> {
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  // ONE deadline for the whole chain. A per-hop signal would multiply the budget by
  // the hop count — the inbox key fetch passes 8s to bound a slowloris (#H7), and
  // four hops of 8s each would quietly turn that into 32s of held request on a path
  // any unauthenticated peer can trigger. Following redirects by hand is what
  // introduced the risk: a single fetch() covered the auto-followed chain with one
  // signal, and this has to reproduce that.
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  let current = url;
  let firstHost: string;
  try {
    firstHost = new URL(url).hostname;
  } catch {
    throw new GuardedFetchError(`${opts.label}: unparseable URL ${url}`, true);
  }

  for (let hop = 0; hop <= maxHops; hop++) {
    // Every hop. This line is the entire fix.
    if (!(await assertPublicHost(current))) {
      throw new GuardedFetchError(`${opts.label}: refusing non-public host ${current}`);
    }

    const init = typeof opts.init === "function" ? await opts.init(current) : (opts.init ?? {});
    const res = await fetch(current, {
      ...init,
      redirect: "manual", // we follow, so we can re-check and re-sign
      signal: deadline,
      // The check above and the socket below must agree about which address
      // this hostname means (#434). Without the dispatcher they are two separate
      // DNS lookups, and the attacker owns the zone between them. `dispatcher`
      // is undici's own extension to RequestInit, hence the cast.
      dispatcher: guardedDispatcher(),
    } as RequestInit & { dispatcher: unknown });

    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (!location) return res;

    const currentProtocol = new URL(current).protocol;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new GuardedFetchError(`${opts.label}: unparseable redirect from ${current}`, true);
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new GuardedFetchError(`${opts.label}: refusing redirect to ${next.protocol} from ${current}`, true);
    }
    if (!opts.crossOrigin && next.hostname !== firstHost) {
      throw new GuardedFetchError(`${opts.label}: refusing cross-host redirect ${firstHost} → ${next.hostname}`, true);
    }
    // Never downgrade. The host pin above is on hostname only, so without this a
    // peer could answer `301 Location: http://same-host/inbox` and we would re-sign
    // and re-send the activity in cleartext — and for a DM the activity body IS the
    // message. Upgrading (http → https) stays allowed; only the downgrade is refused.
    if (currentProtocol === "https:" && next.protocol === "http:") {
      throw new GuardedFetchError(`${opts.label}: refusing https → http downgrade at ${current}`, true);
    }
    current = next.toString();
  }

  throw new GuardedFetchError(`${opts.label}: too many redirects from ${url}`, true);
}

/**
 * `guardedFetch` for the common read: fetch JSON from a remote-controlled URL,
 * `null` on anything going wrong.
 *
 * Swallows the reason on purpose — every existing caller already degraded silently
 * to `null`, and a remote being unreachable is routine rather than notable.
 */
export async function guardedFetchJson<T = unknown>(
  url: string,
  opts: { label: string; timeoutMs: number; accept?: string },
): Promise<T | null> {
  try {
    const res = await guardedFetch(url, {
      crossOrigin: true,
      label: opts.label,
      timeoutMs: opts.timeoutMs,
      init: { headers: { Accept: opts.accept ?? "application/activity+json" } },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
