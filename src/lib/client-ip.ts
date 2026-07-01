/**
 * Resolve a rate-limit bucket key from a request.
 *
 * Forwarded headers are attacker-controllable unless a trusted reverse proxy
 * sets them, so they're honoured ONLY when TRUSTED_PROXY=true; otherwise every
 * request shares a single "default" bucket — stricter, not laxer (an attacker
 * can't rotate spoofed headers to mint unlimited buckets and defeat a rate limit,
 * H2/H3). When trusted, prefer `CF-Connecting-IP`: Cloudflare sets it to the real
 * client and a client can't override it through CF, whereas CF *appends* to
 * `X-Forwarded-For` — so the XFF leftmost hop is client-supplied and spoofable.
 * Used by the admin-login, XML-RPC, guest-comment, and kudos limiters so the
 * keying invariant lives in exactly one place.
 */
export function rateLimitKey(req: { headers: { get(name: string): string | null } }): string {
  if (process.env.TRUSTED_PROXY === "true") {
    // Fall THROUGH to the next header when one is present but blank after trim —
    // a whitespace-only value must not early-return "default" and skip the rest,
    // which would collapse those requests into one shared bucket.
    const cf = req.headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf;
    const xff = req.headers.get("x-forwarded-for")?.split(",")[0].trim();
    if (xff) return xff;
    const xrip = req.headers.get("x-real-ip")?.trim();
    if (xrip) return xrip;
  }
  return "default";
}
