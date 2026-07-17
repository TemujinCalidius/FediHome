import type { MetadataRoute } from "next";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { resolveTheme } from "@/lib/themes";

// Render per request so an admin's site name/description edit is reflected —
// a statically-prerendered manifest would freeze the build-time env values.
export const dynamic = "force-dynamic";

// Served at /manifest.webmanifest; Next auto-injects <link rel="manifest">.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const site = await getRuntimeSiteConfig();
  // Follow the active theme's darkest surface, so an installed PWA's splash +
  // chrome match the site instead of being frozen to the default's near-black.
  const ground = resolveTheme(site.theme.id).tokens.colors["surface-950"];
  return {
    name: site.name,
    short_name: site.name,
    description: site.description,
    start_url: "/timeline",
    scope: "/",
    display: "standalone",
    background_color: ground,
    theme_color: ground,
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
