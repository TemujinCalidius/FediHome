import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SIDEBAR_BLOCKS, SIDEBAR_SIDES,
  isSidebarBlock, isSidebarSide, sidebarBlockLabel,
  parseSidebarBlocks, resolveSidebarBlocks,
} from "@/lib/sidebar";

describe("sidebar side (#307)", () => {
  it("accepts only left/right", () => {
    for (const s of SIDEBAR_SIDES) expect(isSidebarSide(s)).toBe(true);
    expect(isSidebarSide("top")).toBe(false);
    expect(isSidebarSide("")).toBe(false);
  });
});

describe("parseSidebarBlocks (#307)", () => {
  it("splits, trims, lowercases and preserves the given ORDER", () => {
    expect(parseSidebarBlocks("recent, About ,connect")).toEqual(["recent", "about", "connect"]);
  });

  it("dedupes while keeping first position", () => {
    expect(parseSidebarBlocks("connect,about,connect")).toEqual(["connect", "about"]);
  });

  it("drops unknown names rather than rendering nothing", () => {
    expect(parseSidebarBlocks("about,tags,connect")).toEqual(["about", "connect"]);
  });

  it("blank / garbage / null → [] so callers fall back to the default order", () => {
    expect(parseSidebarBlocks("")).toEqual([]);
    expect(parseSidebarBlocks(null)).toEqual([]);
    expect(parseSidebarBlocks(" , ,")).toEqual([]);
    expect(parseSidebarBlocks("nonsense")).toEqual([]);
  });
});

describe("resolveSidebarBlocks (#307)", () => {
  it("empty → the built-in order", () => {
    expect(resolveSidebarBlocks([])).toEqual(SIDEBAR_BLOCKS);
  });

  it("a configured list wins, order intact", () => {
    expect(resolveSidebarBlocks(["connect", "about"])).toEqual(["connect", "about"]);
  });

  it("omitting a block is how you hide it — notably `sections`, which fixes the header duplication", () => {
    const resolved = resolveSidebarBlocks(parseSidebarBlocks("about,recent,connect"));
    expect(resolved).not.toContain("sections");
    expect(resolved).toEqual(["about", "recent", "connect"]);
  });

  it("returns a copy, so a caller can't mutate the shared default", () => {
    const a = resolveSidebarBlocks([]);
    a.pop();
    expect(resolveSidebarBlocks([])).toEqual(SIDEBAR_BLOCKS); // still all four
  });
});

describe("block metadata (#307)", () => {
  it("every block is recognised and has a label", () => {
    for (const b of SIDEBAR_BLOCKS) {
      expect(isSidebarBlock(b)).toBe(true);
      expect(sidebarBlockLabel(b).length).toBeGreaterThan(0);
    }
    expect(isSidebarBlock("tags")).toBe(false); // not built yet — needs a public tag route
  });
});

/**
 * #307 item 3 — a title-less post in the Recent block.
 *
 * `{p.title || "Untitled"}` gave any microblog a column of five "Untitled"s: a
 * note legitimately has no title. That is exactly the problem #253 solved for
 * `GET /api/posts`, and it is solved the same way here — `postOgDescription`,
 * the same helper the API's `preview` field uses — so the sidebar, the API and
 * the Mac app all describe a title-less post identically rather than three ways.
 *
 * Behaviour is asserted against the real loader; the rendering is a source scan,
 * since the component is a server component with a live Prisma dependency and
 * standing up the whole page to read two spans would test the harness.
 */
describe("#307 item 3 — recent posts without a title", () => {
  const dataSrc = readFileSync(
    join(process.cwd(), "src/components/layout/sidebarData.ts"), "utf-8",
  );
  const viewSrc = readFileSync(
    join(process.cwd(), "src/components/layout/Sidebar.tsx"), "utf-8",
  );

  it("no longer falls back to a placeholder title", () => {
    // The expression, not the word — the comment above the fix names the old
    // behaviour on purpose, and a bare word search would match that instead.
    expect(viewSrc).not.toMatch(/p\.title\s*\|\|/);
  });

  it("uses the SAME preview helper the posts API uses", () => {
    // Not a second snippet implementation. Two helpers would drift, and the
    // symptom would be the sidebar and the app disagreeing about what a post
    // says — which is worse than either being wrong on its own.
    expect(dataSrc).toContain("postOgDescription");
  });

  it("selects the columns that helper needs", () => {
    // The query used to take slug/title/publishedAt only, so the helper would
    // silently have nothing to work from and every snippet would be empty.
    for (const col of ["excerpt: true", "contentHtml: true", "content: true"]) {
      expect(dataSrc, `recent-posts query is missing ${col}`).toContain(col);
    }
  });

  it("passes an EMPTY fallback, not the site description", () => {
    // postOgDescription defaults to the site tagline, which is right for an OG
    // card that must never be textless and wrong here: five identical taglines
    // down a sidebar is a worse wall than "Untitled" was.
    expect(dataSrc).toMatch(/postOgDescription\(p,\s*""\)/);
  });

  it("computes a snippet only for posts that actually lack a title", () => {
    expect(dataSrc).toMatch(/p\.title\s*\?\s*""\s*:/);
  });

  it("falls back to the date when there is no title and no text", () => {
    // A photo-only note. Showing nothing but a date is at least true; the old
    // code would have said "Untitled" and the naive fix renders a blank line.
    expect(viewSrc).toMatch(/p\.snippet\s*\?[\s\S]{0,400}?:\s*null/);
  });
});
