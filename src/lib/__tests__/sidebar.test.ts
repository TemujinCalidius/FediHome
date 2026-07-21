import { describe, it, expect } from "vitest";
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
