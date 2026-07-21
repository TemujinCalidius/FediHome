/**
 * Sidebar configuration (#307) — which blocks the sidebar shows, in what order,
 * and which side it sits on. Kept pure (no prisma / server-only imports) so both
 * server components and the admin client bundle can use it, exactly like
 * `@/lib/categories` and `@/lib/themes`.
 *
 * The block list is deliberately ONE ordered CSV rather than a set of toggles
 * plus a separate order: the list order IS the render order, and omitting a
 * block hides it. That also settles the header/sidebar duplication — drop
 * `sections` and your nav appears once, not twice.
 */

/** Which side of the content the sidebar sits on. `right` is the shipped default. */
export type SidebarSide = "right" | "left";
export const SIDEBAR_SIDES: SidebarSide[] = ["right", "left"];

export function isSidebarSide(v: string): v is SidebarSide {
  return (SIDEBAR_SIDES as readonly string[]).includes(v);
}

/** Every block the sidebar can render. Order here is the built-in default order. */
export type SidebarBlock = "about" | "recent" | "sections" | "connect";
export const SIDEBAR_BLOCKS: SidebarBlock[] = ["about", "recent", "sections", "connect"];

export function isSidebarBlock(v: string): v is SidebarBlock {
  return (SIDEBAR_BLOCKS as readonly string[]).includes(v);
}

/** Human label for the admin UI. */
export function sidebarBlockLabel(block: SidebarBlock): string {
  const labels: Record<SidebarBlock, string> = {
    about: "About",
    recent: "Recent posts",
    sections: "Sections",
    connect: "Connect",
  };
  return labels[block];
}

/**
 * Parse a comma-separated block list: trim, lowercase, keep only known blocks,
 * dedupe. A blank or entirely-unknown string yields `[]` so callers fall back to
 * the built-in order. (Unknown names are rejected at save time by
 * `validateSiteConfigValue`, so this is the belt to that braces.)
 */
export function parseSidebarBlocks(csv: string | null | undefined): SidebarBlock[] {
  if (!csv) return [];
  const out: SidebarBlock[] = [];
  for (const raw of csv.split(",")) {
    const name = raw.trim().toLowerCase();
    if (isSidebarBlock(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The effective block list: the parsed order, or the built-in default when empty. */
export function resolveSidebarBlocks(parsed: SidebarBlock[]): SidebarBlock[] {
  return parsed.length ? parsed : [...SIDEBAR_BLOCKS];
}
