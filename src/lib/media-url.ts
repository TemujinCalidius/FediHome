import { siteConfig } from "@/../site.config";

/**
 * Normalise a media URL for rendering with `next/image`.
 *
 * Uploaded post media is stored ABSOLUTE (`${SITE_URL}/uploads/...`, so
 * federation/RSS get full URLs). But `next/image` rejects an absolute URL whose
 * host isn't in `images.remotePatterns` with a 400 ("url parameter is not
 * allowed") — and the instance's own domain can't be reliably allow-listed at
 * build time (Docker builds before SITE_URL exists). So for on-page rendering we
 * strip our OWN origin, turning a same-origin absolute URL into a relative one
 * that the optimizer treats as a local image. Cross-origin/federated URLs (e.g.
 * PeerTube thumbnails, already allow-listed) pass through unchanged.
 *
 * Render-layer only — federation (`ap-post.ts`) and RSS (`feed.xml`)
 * re-absolutise from `siteConfig.url` independently, so they are unaffected.
 * Mirrors the write-time normalisation `api/admin/_actions/profile.ts` already
 * does for avatar/banner paths.
 */
export function localMediaSrc(url: string): string {
  if (!url) return url;
  try {
    const self = new URL(siteConfig.url).origin;
    const u = new URL(url, siteConfig.url); // absolute stays absolute; relative resolves to self
    return u.origin === self ? u.pathname + u.search + u.hash : url;
  } catch {
    return url;
  }
}
