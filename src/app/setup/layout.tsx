import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Setup — FediHome",
  description: "Set up your FediHome instance.",
};

export default function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Render children without the main site Navbar/Footer
  return <>{children}</>;
}
