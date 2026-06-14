import type { Metadata, Viewport } from "next";
import "./globals.css";
import Navbar from "@/components/layout/Navbar";
import Footer from "@/components/layout/Footer";
import ScrollToTop from "@/components/ui/ScrollToTop";
import { siteConfig } from "@/../site.config";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
    template: `%s — ${siteConfig.name}`,
  },
  description: siteConfig.description,
  authors: [{ name: siteConfig.authorName }],
  openGraph: {
    type: "website",
    locale: "en_AU",
    url: "/",
    title: siteConfig.name,
    description: siteConfig.description,
    siteName: siteConfig.name,
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
    title: siteConfig.name,
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

export const viewport: Viewport = {
  themeColor: "#0a0a0f",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="micropub" href={`${siteConfig.url}/api/micropub`} />
        <link rel="token_endpoint" href={`${siteConfig.url}/api/micropub`} />
        <link rel="authorization_endpoint" href={`${siteConfig.url}/api/micropub`} />
        <link rel="EditURI" type="application/rsd+xml" href={`${siteConfig.url}/rsd.xml`} />
      </head>
      <body className="bg-surface-950 text-gray-200 min-h-screen flex flex-col font-body">
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
        <ScrollToTop />
      </body>
    </html>
  );
}
