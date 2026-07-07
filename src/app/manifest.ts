import type { MetadataRoute } from "next";
import { getRuntimeSiteConfig } from "@/lib/site-settings";

// Render per request so an admin's site name/description edit is reflected —
// a statically-prerendered manifest would freeze the build-time env values.
export const dynamic = "force-dynamic";

// Served at /manifest.webmanifest; Next auto-injects <link rel="manifest">.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const site = await getRuntimeSiteConfig();
  return {
    name: site.name,
    short_name: site.name,
    description: site.description,
    start_url: "/timeline",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0f",
    theme_color: "#0a0a0f",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
