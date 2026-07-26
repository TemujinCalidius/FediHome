/**
 * "Can the Fediverse reach this host?" — a pure, dependency-free string check.
 *
 * Deliberately NOT the same thing as `url-guard.ts`. That one is an SSRF guard
 * for OUTBOUND fetches against untrusted URLs: it resolves DNS, decodes exotic
 * IP encodings, and errs toward refusing anything suspicious. This one is about
 * OUR OWN advertised identity — a plain question about a hostname we chose, used
 * to stop an instance federating under an address nobody else can resolve.
 *
 * Kept import-free so the setup wizard's client component can use the exact same
 * rules as the server. Three divergent copies of this logic existed before
 * (#357): the setup route, the setup page, and the SSRF guard's different rule
 * set. A rule that only *some* paths enforce is worse than no rule, because the
 * one unguarded path is the one people hit.
 */

/**
 * True when a hostname can't be reached from the public internet — loopback,
 * RFC1918 space, link-local, or IPv6 unique-local.
 *
 * Why it matters: `SITE_URL` becomes the ActivityPub actor id, and because
 * `Post.apId` stores absolute URLs, it is baked into every post published
 * before you move. An unreachable identity can't be corrected after the fact —
 * remote servers hold the old one, and FediHome has no outbound `Move` yet
 * (#347).
 */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true; // no host at all is certainly not reachable
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  if (/^127\./.test(h)) return true;
  if (/^(10\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true; // IPv6 unique-local
  if (h === "0.0.0.0" || h === "::") return true; // bind-all, never an identity
  return false;
}

/** Convenience: the same question asked of a whole URL. Unparseable → true. */
export function isLocalOrPrivateUrl(url: string): boolean {
  try {
    return isLocalOrPrivateHost(new URL(url).hostname);
  } catch {
    return true;
  }
}
