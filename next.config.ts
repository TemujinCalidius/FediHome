import type { NextConfig } from "next";

const PEERTUBE_HOSTS = [
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
];

const nextConfig: NextConfig = {
  // Emit a self-contained server in .next/standalone for the Docker image.
  // The non-Docker path (`next start`, used by pm2 / the demo) is unaffected —
  // standalone is just additional build output.
  output: "standalone",
  images: {
    // Add your own domain(s) here, e.g.:
    // remotePatterns: [{ protocol: "https", hostname: "yourdomain.com" }, ...]
    remotePatterns: [
      ...PEERTUBE_HOSTS.map((hostname) => ({
        protocol: "https" as const,
        hostname,
      })),
    ],
  },
  async headers() {
    const frameSrc = ["'self'", ...PEERTUBE_HOSTS.map((h) => `https://${h}`)].join(" ");
    // Allow the Tinylytics tracking embed + its beacons. Always allowed now that
    // the site code is web-editable (#59) — this `headers()` is static (build
    // time) and can't read the runtime DB config, so it can't be env-gated. The
    // domain is only ever contacted when the embed actually renders (i.e. when
    // analytics is configured), so listing it is inert for sites that don't use
    // it. (#170)
    const tinylytics = " https://tinylytics.app";
    // NOTE: 'unsafe-inline' on script-src is still required for Next.js App Router
    // hydration data scripts. Tightening to nonces is tracked separately and needs
    // every <Script> usage updated to read a nonce from middleware.
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline'${tinylytics}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' https: data:",
              "media-src 'self' https:",
              "font-src 'self'",
              `connect-src 'self'${tinylytics}`,
              `frame-src ${frameSrc}`,
              "frame-ancestors 'none'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
        ],
      },
      // Stricter sandbox for user-uploaded content — even if a stored payload
      // slips through media validation, scripts in it cannot execute.
      {
        source: "/uploads/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      // Service worker must not be cached (so updates roll out) and is allowed to
      // control the whole origin scope for Web Push.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
