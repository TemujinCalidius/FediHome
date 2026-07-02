import { describe, it, expect } from "vitest";
// The CI guard + release-prep logic live in dependency-free .mjs scripts so the
// workflow can run them without npm ci; tested here from the same source.
import { checkDevSync, checkReleaseReady, validateHeadings, toLines } from "../../../scripts/check-changelog-sync.mjs";
import { bumpVersion, convertUnreleased } from "../../../scripts/prepare-release.mjs";

const MAIN = `# Changelog

## 1.7.0 (2026-07-01)

### Added
- Big feature. (#158)

## 1.6.1 (2026-07-01)

### Fixed
- A bug. (#103)
`;

const DEV_OK = `# Changelog

## Unreleased

### Added
- New thing. (#183)

${MAIN.split("\n").slice(2).join("\n")}`;

describe("check-changelog-sync: dev mode", () => {
  it("passes when dev = Unreleased + main's history verbatim", () => {
    expect(checkDevSync(DEV_OK, MAIN, "1.7.0")).toEqual([]);
  });

  it("passes with no Unreleased section at all (identical files)", () => {
    expect(checkDevSync(MAIN, MAIN, "1.7.0")).toEqual([]);
  });

  it("fails when a released heading was dropped (the historical 1.6.0 incident)", () => {
    const dropped = DEV_OK.replace("## 1.6.1 (2026-07-01)\n\n### Fixed\n- A bug. (#103)\n", "");
    const errors = checkDevSync(dropped, MAIN, "1.7.0");
    expect(errors.some((e: string) => e.includes("don't match main"))).toBe(true);
  });

  it("fails when a released entry was edited on dev", () => {
    const edited = DEV_OK.replace("- Big feature. (#158)", "- Big feature, reworded. (#158)");
    expect(checkDevSync(edited, MAIN, "1.7.0")).not.toEqual([]);
  });

  it("fails when an entry lands below the fold (inside a released section)", () => {
    const belowFold = DEV_OK.replace("- Big feature. (#158)", "- Big feature. (#158)\n- Sneaky new entry. (#999)");
    expect(checkDevSync(belowFold, MAIN, "1.7.0")).not.toEqual([]);
  });

  it("allows exactly one new release-prep section matching package.json", () => {
    const prepped = DEV_OK.replace("## Unreleased", "## 1.8.0 (2026-07-03)");
    expect(checkDevSync(prepped, MAIN, "1.8.0")).toEqual([]);
  });

  it("rejects a release-prep section that doesn't match package.json", () => {
    const prepped = DEV_OK.replace("## Unreleased", "## 1.8.0 (2026-07-03)");
    const errors = checkDevSync(prepped, MAIN, "1.7.0");
    expect(errors.some((e: string) => e.includes("package.json"))).toBe(true);
  });

  it("rejects two new version sections above main's history", () => {
    const two = DEV_OK.replace("## Unreleased", "## 1.9.0 (2026-07-04)\n\n- x\n\n## 1.8.0 (2026-07-03)");
    expect(checkDevSync(two, MAIN, "1.9.0")).not.toEqual([]);
  });

  it("rejects a new section duplicating main's latest release", () => {
    const dup = DEV_OK.replace("## Unreleased", "## 1.7.0 (2026-07-02)");
    expect(checkDevSync(dup, MAIN, "1.7.0")).not.toEqual([]);
  });

  it("is line-ending tolerant (CRLF dev vs LF main)", () => {
    expect(checkDevSync(DEV_OK.replace(/\n/g, "\r\n"), MAIN, "1.7.0")).toEqual([]);
  });

  it("tolerates EOF trailing-newline churn (not history drift)", () => {
    expect(checkDevSync(DEV_OK.trimEnd(), MAIN, "1.7.0")).toEqual([]);
    expect(checkDevSync(DEV_OK + "\n\n", MAIN, "1.7.0")).toEqual([]);
  });

  it("catches CommonMark heading spoofing (leading spaces / tab after ##)", () => {
    // ' ## X.Y.Z' renders as a real h2 but isn't canonical — must be flagged.
    const spoofed = DEV_OK.replace(
      "## Unreleased",
      "## Unreleased\n\n### Added\n- legit\n\n ## 1.7.1 (2026-07-02)\n\n- fake release entry",
    );
    expect(checkDevSync(spoofed, MAIN, "1.7.0").some((e: string) => e.includes("malformed heading"))).toBe(true);
    const tabbed = DEV_OK.replace("## Unreleased", "##\t1.7.1 (2026-07-02)");
    expect(checkDevSync(tabbed, MAIN, "1.7.1")).not.toEqual([]);
  });

  it("locks the header zone: no content between '# Changelog' and Unreleased", () => {
    const junk = DEV_OK.replace("# Changelog\n", "# Changelog\n\nSneaky preamble content.\n");
    expect(checkDevSync(junk, MAIN, "1.7.0").some((e: string) => e.includes("header"))).toBe(true);
    const fakeH1 = DEV_OK.replace("# Changelog\n", "# Changelog\n\n# 1.9.9 (2026-07-02)\n- fake\n");
    expect(checkDevSync(fakeH1, MAIN, "1.7.0")).not.toEqual([]);
  });

  it("rejects re-releasing ANY prior version, not just main's top", () => {
    // main also contains 1.6.1 — re-adding it (with pkg downgraded) must fail.
    const older = DEV_OK.replace("## Unreleased", "## 1.6.1 (2026-07-02)");
    expect(checkDevSync(older, MAIN, "1.6.1").some((e: string) => e.includes("already released"))).toBe(true);
  });

  it("requires a release-prep version to be semver-greater than main's latest", () => {
    const between = DEV_OK.replace("## Unreleased", "## 1.6.5 (2026-07-02)");
    expect(checkDevSync(between, MAIN, "1.6.5").some((e: string) => e.includes("isn't greater"))).toBe(true);
  });

  it("ignores '## '-looking lines inside fenced code blocks", () => {
    const fenced = DEV_OK.replace(
      "- New thing. (#183)",
      "- New thing. (#183)\n- Example:\n\n```md\n## Not a real heading\n```",
    );
    expect(checkDevSync(fenced, MAIN, "1.7.0")).toEqual([]);
  });
});

describe("check-changelog-sync: release mode", () => {
  it("passes a converted changelog whose top version matches package.json", () => {
    expect(checkReleaseReady(MAIN, "1.7.0")).toEqual([]);
  });

  it("fails when Unreleased still exists", () => {
    const errors = checkReleaseReady(DEV_OK, "1.7.0");
    expect(errors.some((e: string) => e.includes("Unreleased"))).toBe(true);
  });

  it("fails on a whitespace-spoofed ' ## Unreleased' too", () => {
    const spoofed = MAIN.replace("## 1.7.0 (2026-07-01)", " ## Unreleased\n\n- pending\n\n## 1.7.0 (2026-07-01)");
    expect(checkReleaseReady(spoofed, "1.7.0")).not.toEqual([]);
  });

  it("fails when the top version doesn't match package.json", () => {
    const errors = checkReleaseReady(MAIN, "1.8.0");
    expect(errors.some((e: string) => e.includes("package.json"))).toBe(true);
  });
});

describe("check-changelog-sync: heading validation", () => {
  it("flags malformed version headings", () => {
    const bad = toLines("# Changelog\n\n## v1.7.0 — July\n- x\n");
    expect(validateHeadings(bad).length).toBeGreaterThan(0);
  });

  it("flags duplicate Unreleased headings and Unreleased below a version", () => {
    const dupe = toLines("# Changelog\n\n## Unreleased\n\n## Unreleased\n");
    expect(validateHeadings(dupe).some((e: string) => e.includes("multiple"))).toBe(true);
    const below = toLines("# Changelog\n\n## 1.7.0 (2026-07-01)\n\n## Unreleased\n");
    expect(validateHeadings(below).some((e: string) => e.includes("before all version sections"))).toBe(true);
  });
});

describe("prepare-release", () => {
  it("bumps major/minor/patch and accepts a greater explicit version", () => {
    expect(bumpVersion("1.7.0", "minor")).toBe("1.8.0");
    expect(bumpVersion("1.7.0", "major")).toBe("2.0.0");
    expect(bumpVersion("1.7.0", "patch")).toBe("1.7.1");
    expect(bumpVersion("1.7.0", "1.7.2")).toBe("1.7.2");
  });

  it("rejects a non-greater or malformed explicit version", () => {
    expect(() => bumpVersion("1.7.0", "1.7.0")).toThrow();
    expect(() => bumpVersion("1.7.0", "1.6.9")).toThrow();
    expect(() => bumpVersion("1.7.0", "banana")).toThrow();
  });

  it("converts Unreleased to a dated version heading", () => {
    const out = convertUnreleased(DEV_OK, "1.8.0", "2026-07-03");
    expect(out).toContain("## 1.8.0 (2026-07-03)");
    expect(out).not.toContain("## Unreleased");
    // The converted result must satisfy the dev-mode sync check (release-prep case).
    expect(checkDevSync(out, MAIN, "1.8.0")).toEqual([]);
  });

  it("refuses an empty or missing Unreleased section", () => {
    expect(() => convertUnreleased(MAIN, "1.8.0", "2026-07-03")).toThrow(/no '## Unreleased'/);
    const empty = "# Changelog\n\n## Unreleased\n\n" + MAIN.split("\n").slice(2).join("\n");
    expect(() => convertUnreleased(empty, "1.8.0", "2026-07-03")).toThrow(/empty/);
  });
});
