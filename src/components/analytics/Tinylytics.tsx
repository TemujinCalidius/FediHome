import Script from "next/script";

/**
 * Tinylytics pageview tracking embed (#170). This is what actually COLLECTS hits;
 * without it, the analytics dashboard, footer hit counter, and per-post view
 * counts have no data to show.
 *
 * Keyed by the site code (`TINYLYTICS_SITE_ID`, or `TINYLYTICS_EMBED_ID` if your
 * embed code differs from the API site id). The API key is NEVER used here — it
 * stays server-side. Renders nothing when unconfigured, so it's zero-cost when
 * Tinylytics isn't set up. Requires `https://tinylytics.app` in the CSP
 * script-src/connect-src (added conditionally in next.config.ts).
 */
export default function Tinylytics() {
  const siteCode = process.env.TINYLYTICS_EMBED_ID || process.env.TINYLYTICS_SITE_ID;
  if (!siteCode) return null;
  return (
    <Script
      src={`https://tinylytics.app/embed/${encodeURIComponent(siteCode)}.js`}
      strategy="afterInteractive"
    />
  );
}
