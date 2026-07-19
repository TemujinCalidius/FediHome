import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { resolveLayout } from "@/lib/themes";

/**
 * The public page shell (#250) — the frame around every visitor-facing page.
 *
 * It lives in the `(public)` route group so it wraps ONLY public pages, never
 * `/admin`, `/setup`, `/compose`, `/timeline` or `/search`. Route groups don't
 * change URLs, so every path is exactly what it was before. This is what makes
 * a site-wide shell (and, later, the Classic Blog sidebar) possible at all: the
 * root layout is shared by the admin surfaces too, and a server layout can't
 * read the pathname — so the split is the mechanism, not a stylistic choice.
 *
 * `normal` renders NOTHING extra, so a default instance is byte-identical.
 * `narrow` clamps the column; it composes over each page's own `max-w-*`
 * because the narrower of the two always wins. (`wide` and `sidebar` join in a
 * later phase — `wide` first needs the per-page widths centralised.)
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const site = await getRuntimeSiteConfig();
  const { shell } = resolveLayout(site.theme.id, site.layout);

  if (shell === "narrow") {
    return <div className="mx-auto w-full max-w-2xl">{children}</div>;
  }
  return <>{children}</>; // "normal" — no wrapper, identical to before
}
