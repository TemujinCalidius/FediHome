/**
 * Resolve the public client IP for a request.
 *
 * We sit behind a Cloudflare Tunnel; CF sets `CF-Connecting-IP` to the original
 * client. `X-Forwarded-For` is attacker-controllable when sent directly (e.g.,
 * the user-supplied origin can spoof it), so we only trust it after CF.
 *
 * Order:
 *   1. CF-Connecting-IP (single, set by Cloudflare).
 *   2. X-Forwarded-For (first hop, only if CF-Connecting-IP is missing — useful in dev).
 *   3. X-Real-IP.
 *   4. "unknown".
 */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();

  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();

  const xrealip = req.headers.get("x-real-ip");
  if (xrealip) return xrealip.trim();

  return "unknown";
}

/**
 * Resolve a rate-limit bucket key. Unlike `clientIp` above, this is the
 * SECURITY-sensitive keying for abuse limits: `X-Forwarded-For` / `X-Real-IP`
 * are attacker-controllable unless a trusted reverse proxy overwrites them, so
 * they're honoured ONLY when TRUSTED_PROXY=true. Otherwise every request shares
 * a single "default" bucket — stricter, not laxer: an attacker can't rotate
 * spoofed headers to mint unlimited buckets and defeat the limit (H2/H3).
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
