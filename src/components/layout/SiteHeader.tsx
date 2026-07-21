import type { HeaderVariant } from "@/lib/themes";
import Navbar from "./Navbar";
import HeaderCentered from "./HeaderCentered";
import HeaderMinimal from "./HeaderMinimal";

/**
 * Header region dispatcher (#250, Phase 4) — the first NON-feed themeable region.
 * The root layout resolves the active header variant (theme preset + owner
 * override, via `resolveLayout`) and this picks the matching header. The default
 * `bar` renders the unchanged `Navbar`, so a default instance is byte-identical;
 * `centered` / `minimal` are owner opt-in.
 */
export default function SiteHeader({ variant }: { variant: HeaderVariant }) {
  if (variant === "centered") return <HeaderCentered />;
  if (variant === "minimal") return <HeaderMinimal />;
  return <Navbar />; // "bar" — the default
}
