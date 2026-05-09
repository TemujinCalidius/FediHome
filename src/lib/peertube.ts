/**
 * PeerTube URL parser + oEmbed metadata fetcher.
 *
 * Accepts URLs like:
 *   https://makertube.net/w/<id>
 *   https://makertube.net/videos/watch/<id>
 *   https://<peertube-host>/w/<id>
 *
 * Returns canonical embed metadata for storage and rendering.
 *
 * SECURITY: only fetches oEmbed from an explicit allowlist of known PeerTube
 * instances to prevent server-side request forgery (SSRF) — any URL pasted in
 * compose ends up here.
 */

const ALLOWED_HOSTS = new Set([
  "makertube.net",
  "tilvids.com",
  "tube.tchncs.de",
  "framatube.org",
  "peertube.tv",
  "video.hardlimit.com",
  "diode.zone",
  "share.tube",
  "kolektiva.media",
  "peertube.linuxrocks.online",
]);

export interface ParsedVideo {
  embedUrl: string;
  embedHost: string;
  embedId: string;
  iframeSrc: string;
  title: string;
  thumbnailUrl: string | null;
  duration: number | null;
  authorName: string | null;
}

/**
 * Extract host + video ID from a PeerTube URL.
 * Returns null if the URL isn't a recognized PeerTube format.
 */
function extractIdAndHost(rawUrl: string): { host: string; id: string } | null {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();

    // Pattern: /w/<id>
    let m = u.pathname.match(/^\/w\/([A-Za-z0-9]+)/);
    if (m) return { host, id: m[1] };

    // Pattern: /videos/watch/<id>
    m = u.pathname.match(/^\/videos\/watch\/([A-Za-z0-9-]+)/);
    if (m) return { host, id: m[1] };

    // Pattern: /videos/embed/<id> (already an embed URL — accept it)
    m = u.pathname.match(/^\/videos\/embed\/([A-Za-z0-9]+)/);
    if (m) return { host, id: m[1] };

    return null;
  } catch {
    return null;
  }
}

/**
 * Build canonical viewing and embed URLs from host + ID.
 */
function buildUrls(host: string, id: string) {
  return {
    embedUrl: `https://${host}/w/${id}`,
    iframeSrc: `https://${host}/videos/embed/${id}`,
  };
}

/**
 * Fetch oEmbed metadata from a PeerTube instance.
 * Returns null if the host is not in the allowlist or the fetch fails.
 */
export async function parsePeerTubeUrl(rawUrl: string): Promise<ParsedVideo | null> {
  const extracted = extractIdAndHost(rawUrl);
  if (!extracted) return null;
  const { host, id } = extracted;

  if (!ALLOWED_HOSTS.has(host)) {
    return null;
  }

  const { embedUrl, iframeSrc } = buildUrls(host, id);

  // PeerTube's oEmbed endpoint
  const oembedUrl = `https://${host}/services/oembed?url=${encodeURIComponent(embedUrl)}&format=json`;

  try {
    const res = await fetch(oembedUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // oEmbed failed but we have enough info to embed regardless — return minimal record
      return {
        embedUrl,
        embedHost: host,
        embedId: id,
        iframeSrc,
        title: "",
        thumbnailUrl: null,
        duration: null,
        authorName: null,
      };
    }
    const data = await res.json() as {
      title?: string;
      thumbnail_url?: string;
      author_name?: string;
      duration?: number;
    };
    return {
      embedUrl,
      embedHost: host,
      embedId: id,
      iframeSrc,
      title: data.title || "",
      thumbnailUrl: data.thumbnail_url || null,
      duration: typeof data.duration === "number" ? Math.round(data.duration) : null,
      authorName: data.author_name || null,
    };
  } catch {
    return {
      embedUrl,
      embedHost: host,
      embedId: id,
      iframeSrc,
      title: "",
      thumbnailUrl: null,
      duration: null,
      authorName: null,
    };
  }
}

/**
 * Compute the iframe src for a stored video URL — used in post rendering.
 */
export function iframeSrcFor(canonicalUrl: string): string | null {
  const parts = extractIdAndHost(canonicalUrl);
  if (!parts) return null;
  return buildUrls(parts.host, parts.id).iframeSrc;
}

export function isAllowedPeerTubeHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host.toLowerCase());
}
