/**
 * Resolve a rate-limit bucket key from a request.
 *
 * `X-Forwarded-For` / `X-Real-IP` are attacker-controllable unless a trusted
 * reverse proxy overwrites them, so they're honoured ONLY when TRUSTED_PROXY=true.
 * Otherwise every request shares a single "default" bucket — stricter, not laxer:
 * an attacker can't rotate spoofed headers to mint unlimited buckets and defeat a
 * rate limit (H2/H3). Used by the admin-login, XML-RPC, guest-comment, and kudos
 * limiters so the keying invariant lives in exactly one place.
 */
export function rateLimitKey(req: { headers: { get(name: string): string | null } }): string {
  if (process.env.TRUSTED_PROXY === "true") {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim() || "default";
    const xrip = req.headers.get("x-real-ip");
    if (xrip) return xrip.trim() || "default";
  }
  return "default";
}
