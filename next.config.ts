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
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' https: data:",
              "media-src 'self' https:",
              "font-src 'self'",
              "connect-src 'self'",
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
