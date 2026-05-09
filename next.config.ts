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
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' https: data:",
              "media-src 'self' https:",
              "font-src 'self'",
              "connect-src 'self'",
              `frame-src ${frameSrc}`,
              "frame-ancestors 'none'",
            ].join("; "),
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
