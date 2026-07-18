import { describe, it, expect } from "vitest";
import {
  DEFAULT_CATEGORIES, MAX_CATEGORIES,
  parseCategoryList, resolveCategoryList, categoryLabel, unionCategories, buildCategoryTabs, normalizeCategory,
  categoryEntries,
} from "@/lib/categories";

describe("parseCategoryList (#284)", () => {
  it("splits, trims, lowercases, keeps only slug tokens, dedupes", () => {
    expect(parseCategoryList("Wildlife, macro ,  LANDSCAPE, wildlife")).toEqual(["wildlife", "macro", "landscape"]);
  });
  it("drops non-slug tokens (spaces, punctuation, accents)", () => {
    expect(parseCategoryList("photo walk, café, ok-slug, bad/slug")).toEqual(["ok-slug"]);
  });
  it("empty / null → []", () => {
    expect(parseCategoryList("")).toEqual([]);
    expect(parseCategoryList(null)).toEqual([]);
    expect(parseCategoryList("  , ,")).toEqual([]);
  });
  it("caps at MAX_CATEGORIES", () => {
    const many = Array.from({ length: 40 }, (_, i) => `c${i}`).join(",");
    expect(parseCategoryList(many)).toHaveLength(MAX_CATEGORIES);
  });
});

describe("resolveCategoryList (#284)", () => {
  it("empty parsed → the built-in default for that kind", () => {
    expect(resolveCategoryList([], "photos")).toEqual(DEFAULT_CATEGORIES.photos);
    expect(resolveCategoryList([], "videos")).toEqual(DEFAULT_CATEGORIES.videos);
  });
  it("passes a configured list through, appending the general fallback when absent", () => {
    expect(resolveCategoryList(["vlog", "review"], "videos")).toEqual(["vlog", "review", "general"]);
    expect(resolveCategoryList(["general", "vlog"], "videos")).toEqual(["general", "vlog"]); // not duplicated
  });
});

describe("categoryLabel (#284)", () => {
  it("title-cases per hyphen word", () => {
    expect(categoryLabel("general")).toBe("General");
    expect(categoryLabel("photo-walk")).toBe("Photo Walk");
    expect(categoryLabel("black-and-white")).toBe("Black And White");
  });
});

describe("unionCategories (#284) — orphan safety", () => {
  it("keeps configured order, appends DB-present extras, dedupes, drops blanks", () => {
    expect(unionCategories(["wildlife", "general"], ["street", "wildlife", "", null, "Macro"]))
      .toEqual(["wildlife", "general", "street", "macro"]);
  });
  it("a removed-but-still-used category survives via the DB side", () => {
    // owner removed "lore" from config, but a video still has it → stays visible
    expect(unionCategories(["general", "vlog"], ["lore"])).toEqual(["general", "vlog", "lore"]);
  });
});

describe("buildCategoryTabs (#284)", () => {
  it("prepends an All tab and labels the rest", () => {
    expect(buildCategoryTabs(["wildlife", "photo-walk"])).toEqual([
      { key: "all", label: "All" },
      { key: "wildlife", label: "Wildlife" },
      { key: "photo-walk", label: "Photo Walk" },
    ]);
  });
});

describe("categoryEntries (#284) — API-client shape", () => {
  it("returns the union as structured {slug,label}, config order first then DB extras", () => {
    expect(categoryEntries(["wildlife", "photo-walk"], ["street", "wildlife"])).toEqual([
      { slug: "wildlife", label: "Wildlife" },
      { slug: "photo-walk", label: "Photo Walk" },
      { slug: "street", label: "Street" },
    ]);
  });
  it("a removed-but-still-used category still appears (via the DB side)", () => {
    expect(categoryEntries(["general"], ["lore"])).toEqual([
      { slug: "general", label: "General" },
      { slug: "lore", label: "Lore" },
    ]);
  });
});

describe("normalizeCategory (#284) — write-side guard", () => {
  it("returns a URL-safe slug, else the fallback", () => {
    expect(normalizeCategory("Wildlife")).toBe("wildlife");
    expect(normalizeCategory("photo walk")).toBe("general"); // space → not a slug
    expect(normalizeCategory("")).toBe("general");
    expect(normalizeCategory(undefined)).toBe("general");
  });
});
