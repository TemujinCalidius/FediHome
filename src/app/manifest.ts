import type { MetadataRoute } from "next";
import { siteConfig } from "@/../site.config";

// Served at /manifest.webmanifest; Next auto-injects <link rel="manifest">.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteConfig.name,
    short_name: siteConfig.name,
    description: siteConfig.description,
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
