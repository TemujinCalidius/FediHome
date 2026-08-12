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

/**
 * Parsed rather than tested for truthiness, matching `flag()` in
 * src/lib/scheduler-config.ts. `process.env.X ? …` would make
 * `FEDIHOME_STANDALONE=false` mean ON, which is exactly what this repo's
 * `=true`/`=false` house style in .env.example invites someone to write.
 */
function standaloneRequested(): boolean {
  const v = process.env.FEDIHOME_STANDALONE;
  if (v == null || v === "") return false;
  return v !== "false" && v !== "0";
}

const nextConfig: NextConfig = {
  // Emit a self-contained server in .next/standalone — for the Docker image
  // ONLY, which is why this is opt-in (#557).
  //
  // It used to be unconditional, on the reasoning that "the non-Docker path is
  // unaffected — standalone is just additional build output". That was true of
  // correctness and wrong about everything else:
  //
  //  1. `next start` warns on EVERY restart that it "does not work with output:
  //     standalone" and tells you to run `.next/standalone/server.js` instead.
  //     That advice is a trap: `.next/standalone/.next/static` is not written,
  //     so following it serves a site with no CSS and no JS. `public/` IS
  //     copied, so it looks like a styling bug rather than a broken server.
  //  2. It costs 104MB on a fresh build here — 779MB on the demo box — that a
  //     pm2 install never executes, half of it a second copy of node_modules.
  //  3. Because of the dynamic-filesystem-access trace #552 flagged, that
  //     directory is a sweep of the whole project: src/, docs/, install.sh,
  //     .env.example, and 522 paths of .git/.
  //
  // The container is unaffected by the switch. Standalone's server.js BAKES the
  // config in as a JSON literal and sets __NEXT_PRIVATE_STANDALONE_CONFIG, which
  // short-circuits config loading — so the runner stage never reads this file
  // and needs no variable. And a typo'd name fails loudly rather than shipping a
  // broken image: the Dockerfile's `COPY .next/standalone` errors when the
  // directory is missing, and CI builds the Dockerfile on every PR (#552).
  //
  // BUILD-TIME ONLY. Do not put FEDIHOME_STANDALONE in .env.local — Next loads
  // .env files before evaluating this config at `next start` as well as at
  // `next build`, so it would bring the warning straight back.
  output: standaloneRequested() ? "standalone" : undefined,
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
