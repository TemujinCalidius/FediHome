import type { FooterVariant } from "@/lib/themes";
import Footer from "./Footer";
import FooterMinimal from "./FooterMinimal";
import FooterColumns from "./FooterColumns";

/**
 * Footer region dispatcher (#250) — the third themeable region, after `feed` and
 * `header`. The root layout resolves the active variant (theme preset + owner
 * override, via `resolveLayout`) and this picks the matching footer. The default
 * `row` renders the unchanged `Footer`, so a default instance is byte-identical;
 * `minimal` / `columns` are owner opt-in.
 */
export default function SiteFooter({ variant }: { variant: FooterVariant }) {
  if (variant === "minimal") return <FooterMinimal />;
  if (variant === "columns") return <FooterColumns />;
  return <Footer />; // "row" — the default
}
