import { guardedFetch } from "./safe-fetch";
import { makeRateLimiter, type OAuthClient } from "./oauth";

/**
 * IndieAuth clients identified by URL (#494) — the other half of #366.
 *
 * Registration (#366) covers CUSTOM-SCHEME clients (Obsidian, Raycast, local
 * helpers), which IndieAuth provably cannot: it authenticates a client by
 * fetching its `client_id`, and a custom scheme has no document to fetch.
 *
 * The reverse is equally true, and is what this file is for. Quill,
 * Micropublish and every other web client have a stable `client_id` that IS a
 * URL, and the whole point of the spec is that fetching it proves the redirect
 * belongs to that client. Making an owner hand-register those is friction for no
 * security gain.
 *
 * THE RISK, STATED UP FRONT: this is an outbound fetch to a URL a stranger
 * chose, PRE-AUTH, on an endpoint `layout.tsx` advertises to the entire web via
 * `rel="authorization_endpoint"`. Four things keep it from being an open proxy:
 *
 *  - `guardedFetch`, which re-validates every redirect hop, so it can't be
 *    walked into the private network (#433/#434);
 *  - a hard byte cap and a tight timeout, so a slow or enormous document costs
 *    a bounded amount;
 *  - a RATE LIMIT on the fetch itself, keyed per caller. #366 could rely on a
 *    negative cache alone because an unknown id cost one indexed query; a
 *    positive fetch is orders of magnitude more expensive, and caching only
 *    helps for ids that repeat — the abusive case is ids that never do;
 *  - a bounded cache in both directions, so a client that IS repeated is fetched
 *    once a while rather than once a request.
 *
 * A fetch failure is "unknown client", never permission.
 */

/** Enough for any real `h-app`; a client that needs more is not one we can vet. */
const MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

/** Positive metadata is stable; the TTL is about picking up a rename, not safety. */
const HIT_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 60_000;
const MAX_CACHE = 200;

/**
 * The fetch budget, per caller, per minute.
 *
 * Deliberately small. A legitimate sign-in needs ONE fetch, and the result is
 * cached for ten minutes; anything doing this twelve times a minute is not
 * signing in. `GET /api/oauth/authorize` has no rate limit of its own — see
 * oauth-clients.ts — so this is the only thing between an unmetered endpoint and
 * an outbound request per hit.
 */
const fetchLimiter = makeRateLimiter(12, 60_000);

interface Cached {
  at: number;
  client: OAuthClient | null; // null = a remembered miss
}

const cache = new Map<string, Cached>();

export function resetIndieAuthCache(): void {
  cache.clear();
}

/**
 * Is this `client_id` a URL we are willing to fetch?
 *
 * The IndieAuth rules, and each one is here because it closes something:
 *  - `https:` only (plus loopback `http:`, which the spec allows for local
 *    development clients);
 *  - no fragment — it is not sent to a server, so two ids that differ only there
 *    are the same document, and treating them as distinct is a cache-poisoning
 *    and rate-limit-evasion primitive;
 *  - no userinfo — credentials in a client id are never legitimate and would be
 *    sent to whatever host follows;
 *  - no dot segments in the path, so `/a/../../b` can't be laundered into a
 *    different origin's document by a permissive server.
 */
/** `.` or `..` as a path segment of the URL AS WRITTEN, query and fragment aside. */
function hasDotSegment(raw: string): boolean {
  const afterScheme = raw.slice(raw.indexOf("://") + 3);
  const slash = afterScheme.indexOf("/");
  if (slash === -1) return false; // no path at all
  const path = afterScheme.slice(slash).split(/[?#]/)[0];
  return path.split("/").some((seg) => seg === "." || seg === "..");
}

export function isUrlClientId(clientId: string): boolean {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.username || u.password) return false;
  // Checked on the RAW string, not on `u.pathname`. The WHATWG parser resolves
  // dot segments away — `new URL("https://a.example/x/../../y").pathname` is
  // "/y" — so the parsed value never contains one and the check would silently
  // pass everything. The supplied string is what matters anyway: it is what gets
  // stored, compared and shown on the consent screen.
  if (hasDotSegment(clientId)) return false;
  if (u.protocol === "https:") return true;
  // Loopback over http, for a client being developed locally. Anything else
  // plaintext is refused: the document is what authenticates the client, and one
  // fetched over http authenticates nothing.
  return (
    u.protocol === "http:" &&
    (u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost")
  );
}

/** Same origin, compared the way a browser would rather than by string prefix. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/* --------------------------- parsing the page --------------------------- */

/**
 * `rel="redirect_uri"` links, from the document and from the `Link:` header.
 *
 * Both, because the spec allows either and a client that uses only the header is
 * not misconfigured — it is doing the cheaper thing. Missing one would refuse a
 * legitimate client with a message about the other.
 */
export function parseRedirectUris(html: string, linkHeader: string | null): string[] {
  const out: string[] = [];

  // <link rel="redirect_uri" href="..."> in either attribute order.
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bredirect_uri\b/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) out.push(href.trim());
  }

  // Link: <https://…/redirect>; rel="redirect_uri", possibly several.
  if (linkHeader) {
    for (const part of linkHeader.split(",")) {
      const href = part.match(/<([^>]+)>/)?.[1];
      if (href && /rel\s*=\s*"?[^";]*\bredirect_uri\b/i.test(part)) out.push(href.trim());
    }
  }

  return [...new Set(out)];
}

/**
 * The client's name from an `h-app` (or `h-x-app`) microformat.
 *
 * Deliberately shallow. A full microformats parser is a dependency and an
 * attack surface for a string that ends up as a label on a consent screen — and
 * the consent screen shows the client_id URL either way, which is the part that
 * actually identifies the client. A missing or hostile name costs the owner
 * nothing because they are looking at the URL.
 */
export function parseAppName(html: string, clientId: string): string {
  const host = (() => {
    try {
      return new URL(clientId).hostname;
    } catch {
      return clientId;
    }
  })();

  // The p-name inside the first h-app container.
  const app = html.match(/class\s*=\s*["'][^"']*\bh-(?:x-)?app\b[^"']*["']/i);
  if (app?.index !== undefined) {
    const after = html.slice(app.index, app.index + 4_000);
    const name =
      after.match(/class\s*=\s*["'][^"']*\bp-name\b[^"']*["'][^>]*>([^<]{1,100})</i)?.[1] ??
      // <a class="h-app" href="…">Name</a> — the name IS the element's text.
      after.match(/^[^>]*>([^<]{1,100})</)?.[1];
    const clean = name?.replace(/\s+/g, " ").trim();
    if (clean) return clean;
  }

  const title = html.match(/<title[^>]*>([^<]{1,100})</i)?.[1]?.replace(/\s+/g, " ").trim();
  return title || host;
}

/* ------------------------------ resolution ------------------------------ */

function put(clientId: string, client: OAuthClient | null): OAuthClient | null {
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(clientId, { at: Date.now(), client });
  return client;
}

/**
 * Resolve a URL `client_id` by fetching it.
 *
 * `rateKey` is the caller's rate-limit key (see `rateLimitKey`). Passed in
 * rather than derived here so this module stays testable without a request, and
 * so the budget is spent by whoever is asking rather than globally — a global
 * budget would let one abuser lock every legitimate client out.
 *
 * Returns null for anything that isn't a client we can vouch for. The caller
 * turns that into the same "not registered" answer an unknown id gets, because
 * from the owner's side those are the same situation.
 */
export async function resolveUrlClient(
  clientId: string,
  rateKey: string,
): Promise<OAuthClient | null> {
  if (!isUrlClientId(clientId)) return null;

  const hit = cache.get(clientId);
  if (hit) {
    const ttl = hit.client ? HIT_TTL_MS : MISS_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.client;
    cache.delete(clientId);
  }

  // AFTER the cache, so a client the owner actually uses is never rate-limited
  // for being popular — only genuinely new fetches spend the budget.
  if (!fetchLimiter.check(rateKey, Date.now())) return null;

  let html: string;
  let linkHeader: string | null;
  try {
    const res = await guardedFetch(clientId, {
      crossOrigin: true,
      label: "indieauth client_id fetch",
      timeoutMs: FETCH_TIMEOUT_MS,
      init: { headers: { Accept: "text/html, application/xhtml+xml" } },
    });
    if (!res.ok) return put(clientId, null);
    linkHeader = res.headers.get("link");
    // Cap by SLICING the body, not by trusting content-length: a header can lie,
    // and a chunked response has none at all.
    html = (await res.text()).slice(0, MAX_BYTES);
  } catch {
    // Unreachable, non-public, too slow, too many hops. Not permission.
    return put(clientId, null);
  }

  const declared = parseRedirectUris(html, linkHeader)
    // Resolved against the client_id, since the spec permits a relative href and
    // a relative one is same-origin by construction.
    .map((u) => {
      try {
        return new URL(u, clientId).toString();
      } catch {
        return null;
      }
    })
    .filter((u): u is string => u !== null);

  return put(clientId, {
    id: clientId,
    label: parseAppName(html, clientId),
    kind: "indieauth",
    // Exact-match list for the CROSS-origin redirects the document declared.
    // Same-origin ones are accepted by validateRedirectUri without appearing
    // here — that is the rule the spec states, and enumerating every same-origin
    // path a client might use is not something a document can do.
    redirectSchemes: declared,
    redirectUris: declared,
    allowLoopback: false,
    loopbackPath: "",
  } as OAuthClient);
}
