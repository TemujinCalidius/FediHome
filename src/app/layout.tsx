import type { Metadata, Viewport } from "next";
import "./globals.css";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import ScrollToTop from "@/components/ui/ScrollToTop";
import PullToRefresh from "@/components/ui/PullToRefresh";
import Tinylytics from "@/components/analytics/Tinylytics";
import { siteConfig } from "@/../site.config";
import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { getRuntimeProfile } from "@/lib/site-profile";
import { buildThemeStyle } from "@/lib/themes";

export async function generateMetadata(): Promise<Metadata> {
  const [site, profile] = await Promise.all([getRuntimeSiteConfig(), getRuntimeProfile()]);
  return {
    metadataBase: new URL(siteConfig.url),
    title: {
      default: site.name,
      template: `%s — ${site.name}`,
    },
    description: site.description,
    authors: [{ name: profile.authorName }],
    openGraph: {
      type: "website",
      locale: "en_AU",
      url: "/",
      title: site.name,
      description: site.description,
      siteName: site.name,
      // Site-wide default preview image. Pages that don't define their own
      // `openGraph` inherit this, so every shared link still gets a card image;
      // pages that set `openGraph` (post, photography) provide their own. (#96)
      images: [siteConfig.ogImagePath],
    },
    twitter: {
      card: "summary_large_image",
      title: site.name,
      description: site.description,
      images: [siteConfig.ogImagePath],
    },
    alternates: {
      types: {
        "application/rss+xml": "/feed.xml",
        "application/activity+json": "/ap/actor",
      },
    },
    robots: { index: true, follow: true },
    // PWA: installable to the iOS/Android home screen. Push (incl. iOS 16.4+) is
    // wired up via /sw.js + the NotificationBell "Enable phone notifications"
    // (dormant until VAPID keys are set in .env.local).
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: site.name,
      statusBarStyle: "black-translucent",
    },
    icons: {
      icon: "/favicon.png",
      apple: "/icons/apple-touch-icon.png",
    },
    other: {
      "micropub": `${siteConfig.url}/api/micropub`,
      "media-endpoint": `${siteConfig.url}/api/media`,
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#0a0a0f",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [site, profile] = await Promise.all([getRuntimeSiteConfig(), getRuntimeProfile()]);
  // Runtime theme tokens (#250): the active theme's tokens + the owner's accent
  // colour, as a `:root:root{…}` block that overrides the static @theme :root.
  // Empty (nothing injected) for a default instance with the default accent, so
  // it renders identically.
  const themeStyle = buildThemeStyle(site.theme.id, profile.accentColor);
  return (
    <html lang="en">
      <head>
        {themeStyle && <style dangerouslySetInnerHTML={{ __html: themeStyle }} />}
        <link rel="micropub" href={`${siteConfig.url}/api/micropub`} />
        {/* IndieAuth/OAuth discovery — point at the real OAuth endpoints (not Micropub) */}
        <link rel="authorization_endpoint" href={`${siteConfig.url}/api/oauth/authorize`} />
        <link rel="token_endpoint" href={`${siteConfig.url}/api/oauth/token`} />
        <link rel="indieauth-metadata" href={`${siteConfig.url}/.well-known/oauth-authorization-server`} />
        <link rel="EditURI" type="application/rsd+xml" href={`${siteConfig.url}/rsd.xml`} />
      </head>
      <body className="bg-surface-950 text-gray-200 min-h-screen flex flex-col font-body">
        <PullToRefresh />
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
        <ScrollToTop />
        <Tinylytics />
      </body>
    </html>
  );
}
