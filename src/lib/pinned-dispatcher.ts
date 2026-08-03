import { Agent } from "undici";
import dns from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isPrivateIPv4, isPrivateIPv6 } from "./url-guard";

/**
 * Closes the DNS-rebinding window in `assertPublicHost` (#434).
 *
 * **The gap.** `assertPublicHost` resolves the hostname and checks every address
 * it gets back. Then `fetch` resolves it AGAIN to open the socket. Two separate
 * lookups, and an attacker who controls the zone can answer the first with a
 * public address and the second with `127.0.0.1`. The check passes and the
 * connection goes somewhere it never validated. A short TTL is all it takes, and
 * nothing in the request path notices.
 *
 * **The fix.** Do the resolution ourselves, at connect time, and hand undici only
 * the addresses we just validated. There is no second lookup to poison, because
 * the lookup that decides and the lookup that connects are the same one.
 *
 * **This is a real undici Dispatcher on purpose.** A duck-typed object with a
 * `dispatch` method is SILENTLY IGNORED by fetch — no error, the callback simply
 * never fires, and the guard looks installed while doing nothing. Verified
 * end-to-end on Node 20.20 (what the Dockerfile runs) and Node 22.22 (CI), both
 * against undici 6.28: the hook fires and the request completes.
 *
 * `opts.all` is **true** in practice, which decides the callback shape — the
 * array form. Getting that wrong doesn't fail loudly; it produces a bare
 * "fetch failed" with no indication that the shape was the problem.
 *
 * A refusal here surfaces as a transport error rather than a `GuardedFetchError`,
 * so `isPolicyRefusal` returns false and `deliverActivity` treats it as
 * NON-permanent. That is the correct classification and it falls out for free: a
 * refusal at this layer is indistinguishable from a resolver failure, exactly as
 * `assertPublicHost`'s own `false` is — and marking those permanent would drop
 * the activity outright with no FailedDelivery row to retry from.
 */

/**
 * One Agent for the process, not one per request. An Agent owns connection pools;
 * building one per call would leak sockets and throw away keep-alive on the
 * federation paths that are chattiest.
 */
let agent: Agent | undefined;

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * Exported so it can be tested directly. Reaching into a constructed Agent to
 * find its connect options is brittle, and this is the part with the security
 * property in it — it needs to be reachable from a test on its own terms.
 */
export function guardedLookup(
  hostname: string,
  opts: { all?: boolean } | undefined,
  cb: LookupCb,
): void {
  dns
    .lookup(hostname, { all: true, verbatim: true })
    .then((addrs) => {
      // EVERY address must be public, and only the surviving ones are
      // handed back. Filtering rather than rejecting outright matters for
      // dual-stack hosts, where one family can be misconfigured while the
      // other is fine — but a host that resolves ONLY to private space is
      // refused, which is the case that matters.
      const safe = addrs.filter((a) =>
        a.family === 6 ? !isPrivateIPv6(a.address) : !isPrivateIPv4(a.address),
      );
      if (safe.length === 0) {
        cb(
          new Error(
            `refusing to connect to ${hostname}: every address it resolves to is private`,
          ),
          // Types want an address argument even on the error path.
          "",
          4,
        );
        return;
      }
      // dns.lookup semantics: the shape depends on opts.all, and undici
      // passes all: true. Both are handled because the option is undici's
      // to choose, not ours.
      if (opts?.all) cb(null, safe);
      else cb(null, safe[0].address, safe[0].family);
    })
    .catch((err) => cb(err as NodeJS.ErrnoException, "", 4));
}

export function guardedDispatcher(): Agent {
  if (agent) return agent;
  // Cast to Node's own `net.LookupFunction`, which is the type undici's
  // `connect.lookup` actually resolves to (its BuildOptions spreads
  // net.TcpNetConnectOpts). Narrow and checkable, unlike the `as never` this
  // replaces — that erased the signature completely, so the callback could have
  // had any shape at all and `tsc` would have agreed (#506).
  //
  // A cast is still needed, and this is the honest reason: undici passes
  // `all: true`, so the callback is handed an ARRAY, while LookupFunction names
  // only the scalar form. `guardedLookup` handles both — it is a superset of
  // what the type asks for, which structural typing cannot express.
  agent = new Agent({ connect: { lookup: guardedLookup as unknown as LookupFunction } });
  return agent;
}

/** Test seam: drop the cached Agent so a fresh one is built. */
export function resetGuardedDispatcher(): void {
  agent = undefined;
}
