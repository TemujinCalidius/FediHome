import Script from "next/script";

/**
 * Tinylytics pageview tracking embed (#170). This is what actually COLLECTS hits;
 * without it, the analytics dashboard, footer hit counter, and per-post view
 * counts have no data to show.
 *
 * Keyed by the site code, resolved server-side from `analytics.embedId ||
 * analytics.siteId` (web-editable in Admin → Site settings, #59) and passed in.
 * The API key is NEVER used here — it stays server-side. Renders nothing when
 * unconfigured, so it's zero-cost when Tinylytics isn't set up. Requires
 * `https://tinylytics.app` in the CSP script-src/connect-src (next.config.ts).
 */
export default function Tinylytics({ siteCode }: { siteCode: string }) {
  if (!siteCode) return null;
  return (
    <Script
      src={`https://tinylytics.app/embed/${encodeURIComponent(siteCode)}.js`}
      strategy="afterInteractive"
    />
  );
}
