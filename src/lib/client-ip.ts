/**
 * Resolve a rate-limit bucket key from a request.
 *
 * Forwarded headers are attacker-controllable unless a trusted reverse proxy
 * sets them, so they're honoured ONLY when TRUSTED_PROXY=true; otherwise every
 * request shares a single "default" bucket — stricter, not laxer (an attacker
 * can't rotate spoofed headers to mint unlimited buckets and defeat a rate
 * limit, H2/H3).
 *
 * WHICH header is trusted is the operator's to declare (#515). This used to try
 * three in a fixed order — `CF-Connecting-IP`, then `X-Forwarded-For`, then
 * `X-Real-IP` — and take the first one present. That is unsound, because a
 * header is only unforgeable if the edge in front of THIS instance overwrites
 * it, and no order is correct for every edge:
 *
 *  - `CF-Connecting-IP` is authoritative behind Cloudflare and nowhere else. On
 *    any other proxy it is an ordinary request header the client sets, so trying
 *    it FIRST meant a client could hand us any bucket key it liked.
 *  - `X-Forwarded-For` is *appended* to by both Cloudflare and the nginx config
 *    this project ships (`$proxy_add_x_forwarded_for`), so its leftmost hop is
 *    whatever the client sent. Spoofable on the documented setup.
 *  - `X-Real-IP` is set to `$remote_addr` — an overwrite — by that same config,
 *    which makes it the only one of the three that config actually secures. It
 *    was checked LAST, so the other two shadowed it.
 *
 * So: `TRUSTED_PROXY_HEADER` names the ONE header to trust, and nothing else is
 * consulted. Only the operator knows what their edge really sets, and that is
 * the one fact no default can guess.
 *
 * Naming `x-forwarded-for` asserts that your edge OVERWRITES it. If it appends
 * — Cloudflare and the shipped nginx config both do — the leftmost hop is the
 * client's and you want a different header.
 *
 * Used by the admin-login, XML-RPC, guest-comment, kudos, search and OAuth
 * limiters, so the keying invariant lives in exactly one place. It also produces
 * the `ipHash` stored against every guest comment, and the pre-auth
 * outbound-fetch budget for IndieAuth `client_id` resolution — where a forged
 * key is an egress-abuse primitive, not just a way to comment twice.
 */

/** The headers an edge can plausibly set authoritatively. Nothing else is accepted. */
const TRUSTED_HEADERS = ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"] as const;
type TrustedHeader = (typeof TRUSTED_HEADERS)[number];

/**
 * What `TRUSTED_PROXY=true` means on its own. `x-real-ip` because it is the only
 * header the nginx config in docs/deployment.md sets by overwrite; behind
 * anything else it is simply absent, and an absent header collapses to the
 * shared bucket rather than trusting a spoofable one.
 */
const DEFAULT_HEADER: TrustedHeader = "x-real-ip";

const isTrustedHeader = (v: string): v is TrustedHeader =>
  (TRUSTED_HEADERS as readonly string[]).includes(v);

/** Warn at most once per process; this runs on every rate-limited request. */
let warned = false;
function warnOnce(message: string) {
  if (warned) return;
  warned = true;
  // Goes to the log tail in the support bundle (#490), which is where an
  // operator wondering why their limits behave oddly will actually look.
  console.warn(`[client-ip] ${message}`);
}

/**
 * The configured header, or null to trust none. Read per call rather than cached
 * so tests — and a process that reloads its environment — see changes.
 */
function trustedHeader(): TrustedHeader | null {
  if (process.env.TRUSTED_PROXY !== "true") return null;
  const raw = process.env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (!raw) return DEFAULT_HEADER;
  if (isTrustedHeader(raw)) return raw;
  // Fail CLOSED on a typo. Falling back to the default would silently trust a
  // header the operator never named, which is the whole bug being fixed here.
  warnOnce(
    `TRUSTED_PROXY_HEADER="${raw}" is not one of ${TRUSTED_HEADERS.join(", ")}; ` +
      `ignoring forwarded headers entirely. Rate limits now share one bucket.`,
  );
  return null;
}

export function rateLimitKey(req: { headers: { get(name: string): string | null } }): string {
  const header = trustedHeader();
  if (!header) return "default";

  const raw = req.headers.get(header);
  // Leftmost hop for XFF; the others carry a single address. `.split(",")` on a
  // single-value header is a no-op, so one path covers all three.
  const value = raw?.split(",")[0].trim();
  if (value) return value;

  // The named header is missing. If ANOTHER forwarded header is present, the
  // edge is speaking a different dialect than configured — almost always
  // TRUSTED_PROXY=true behind Cloudflare with no header named, where the old
  // code silently used CF-Connecting-IP. Say so instead of quietly rate-limiting
  // the whole internet as one client.
  if (!process.env.TRUSTED_PROXY_HEADER) {
    for (const other of TRUSTED_HEADERS) {
      if (other !== header && req.headers.get(other)?.trim()) {
        warnOnce(
          `TRUSTED_PROXY=true with no TRUSTED_PROXY_HEADER set, so "${header}" is assumed, ` +
            `but requests arrive with "${other}" instead. Set TRUSTED_PROXY_HEADER to whichever ` +
            `header your proxy OVERWRITES, or rate limits will treat every visitor as one client.`,
        );
        break;
      }
    }
  }
  return "default";
}
