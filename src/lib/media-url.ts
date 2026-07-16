/**
 * Normalise a media URL for rendering with `next/image`.
 *
 * Uploaded media is stored ABSOLUTE (`${SITE_URL}/uploads/...`, so federation
 * and RSS get full URLs). But `next/image` rejects an absolute URL whose host
 * isn't in `images.remotePatterns` with a 400 ("url parameter is not allowed"),
 * and the instance's own domain can't be reliably allow-listed at build time
 * (Docker builds before SITE_URL exists). So for on-page rendering we strip the
 * origin, turning a same-origin absolute URL into a relative one the optimizer
 * treats as a local image.
 *
 * This works by matching our own media ROOTS (`/uploads/`, `/images/`) rather
 * than comparing against `SITE_URL` — deliberately, because `SITE_URL` is NOT
 * inlined into client bundles, so an origin comparison would relativise during
 * SSR but flip back to absolute when a "use client" component (PhotoGrid,
 * HeroSlider) re-renders on hydration. Path-matching is origin-independent, so
 * it behaves identically on the server and the client. Remote/federated URLs
 * (e.g. PeerTube thumbnails, whose path isn't /uploads or /images) stay
 * absolute, and federation/RSS re-absolutise from `siteConfig.url` in their own
 * serialisers, so they're unaffected.
 */
const LOCAL_MEDIA_ROOTS = ["/uploads/", "/images/"];

export function localMediaSrc(url: string): string {
  if (!url) return url;
  if (url.startsWith("/")) return url; // already relative
  try {
    const u = new URL(url);
    if (LOCAL_MEDIA_ROOTS.some((root) => u.pathname.startsWith(root))) {
      return u.pathname + u.search + u.hash;
    }
    return url; // remote / federated — leave absolute
  } catch {
    return url;
  }
}
