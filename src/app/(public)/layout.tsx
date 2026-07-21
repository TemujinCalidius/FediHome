import { getRuntimeSiteConfig } from "@/lib/site-settings";
import { resolveLayout } from "@/lib/themes";
import Sidebar from "@/components/layout/Sidebar";

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
 * because the narrower of the two always wins.
 * `sidebar` puts the content beside a column of about / recent / sections /
 * connect blocks — the frame the Classic Blog theme is built on. It applies to
 * every public page (galleries simply render narrower beside it). (`wide` joins
 * later — it first needs the per-page widths centralised.)
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const site = await getRuntimeSiteConfig();
  const { shell } = resolveLayout(site.theme.id, site.layout);

  if (shell === "narrow") {
    return <div className="mx-auto w-full max-w-2xl">{children}</div>;
  }
  if (shell === "sidebar") {
    // Same two-column grid + breakpoint already used by the photo detail page,
    // so it collapses to a single column on mobile consistently with the rest
    // of the site.
    //
    // Side (#307) is done with CSS `order`, not by reordering the DOM: content
    // stays FIRST in source order, so on mobile (single column) the reader gets
    // the post before the sidebar either way. Only the desktop columns swap.
    const onLeft = site.sidebar.side === "left";
    const cols = onLeft ? "lg:grid-cols-[300px_1fr]" : "lg:grid-cols-[1fr_300px]";
    return (
      <div className={`max-w-6xl mx-auto px-6 grid grid-cols-1 ${cols} gap-8`}>
        <div className={`min-w-0 ${onLeft ? "lg:order-2" : ""}`}>{children}</div>
        <div className={onLeft ? "lg:order-1" : ""}>
          <Sidebar blocks={site.sidebar.blocks} />
        </div>
      </div>
    );
  }
  return <>{children}</>; // "normal" — no wrapper, identical to before
}
