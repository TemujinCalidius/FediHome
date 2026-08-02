import { describe, it, expect } from "vitest";
import { validateSiteConfigValue, SITE_CONFIG_FIELDS } from "@/lib/site-settings";
import { renderMarkdownToSafeHtml, defaultAboutMarkdown } from "@/lib/markdown";

/**
 * #439. The About page was JSX with exactly one owner-editable paragraph — the
 * bio — rendered as `<p>{authorBio}</p>`, so even a line break was lost. The
 * rest asserted Next.js, ActivityPub and "posts are published using Micropub",
 * which is true of some instances and not all.
 */
describe("the prose field type survives the generic gate (#439)", () => {
  it("accepts a multi-line body", () => {
    // MAX_TEXT is 500 and CONTROL rejects \r\n, so a page body fails BOTH. The
    // branch has to sit before them or it is dead code.
    const md = "# Hi\n\nSome text.\n\n---\n\n- a\n- b\n";
    expect(validateSiteConfigValue("about.markdown", md)).toBe(md);
  });

  it("accepts a body far longer than a label", () => {
    expect(validateSiteConfigValue("about.markdown", "x".repeat(5000))).not.toBeNull();
  });

  it("still has a ceiling", () => {
    // It is read on every render of the page; unbounded is not a kindness.
    expect(validateSiteConfigValue("about.markdown", "x".repeat(64_001))).toBeNull();
  });

  it("normalises CRLF so saving twice can't produce two versions", () => {
    // Nothing downstream distinguishes them, so an invisible difference in
    // stored bytes is pure confusion.
    expect(validateSiteConfigValue("about.markdown", "a\r\nb")).toBe("a\nb");
  });

  it("accepts empty, which is the revert", () => {
    expect(validateSiteConfigValue("about.markdown", "")).toBe("");
  });

  it("does NOT loosen the ordinary text fields", () => {
    // The whole risk of adding a type is that it becomes a general relaxation.
    expect(validateSiteConfigValue("site.name", "a\nb")).toBeNull();
    expect(validateSiteConfigValue("site.name", "x".repeat(501))).toBeNull();
    expect(SITE_CONFIG_FIELDS["about.heading"]).toBe("text");
  });
});

describe("rendering (#439)", () => {
  it("renders markdown to HTML", () => {
    const html = renderMarkdownToSafeHtml("# Title\n\n**bold** and [a link](https://example.com)");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>");
    expect(html).toContain('href="https://example.com"');
  });

  it("keeps a divider, which only works because of #481", () => {
    expect(renderMarkdownToSafeHtml("a\n\n---\n\nb")).toContain("<hr");
  });

  it("sanitises — the row is not trusted just because the owner writes it", () => {
    // A hand-edited row or a restore is not the owner typing. Same reasoning as
    // #431: validate wherever the value comes from.
    const html = renderMarkdownToSafeHtml('<script>alert(1)</script>\n\n<img src=x onerror=y>');
    expect(html).not.toContain("script");
    expect(html).not.toContain("onerror");
  });
});

describe("the built-in copy is built, not stored (#439)", () => {
  it("follows the live address rather than pinning one", () => {
    // So "reset to default" keeps tracking the operator's actual handle instead
    // of whatever it was the day they first pressed save.
    const md = defaultAboutMarkdown({ fediAddress: "@me@example.com", authorBio: "" });
    expect(md).toContain("@me@example.com");
    expect(defaultAboutMarkdown({ fediAddress: "@other@x.test", authorBio: "" })).toContain("@other@x.test");
  });

  it("folds in the bio when there is one", () => {
    // An operator who has only filled in their bio gets the page they already had.
    expect(defaultAboutMarkdown({ fediAddress: "@a@b.test", authorBio: "I write things." }))
      .toContain("I write things.");
  });

  it("falls back to a sentence that points at the editor", () => {
    const md = defaultAboutMarkdown({ fediAddress: "@a@b.test", authorBio: "   " });
    expect(md).toMatch(/Admin → Site settings/);
  });

  it("is valid markdown that survives the round trip", () => {
    const md = defaultAboutMarkdown({ fediAddress: "@a@b.test", authorBio: "Bio." });
    expect(validateSiteConfigValue("about.markdown", md)).toBe(md);
    expect(renderMarkdownToSafeHtml(md)).toContain("<h2");
  });
});

describe("one markdown renderer, not four (#439)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const ROOT = join(__dirname, "..", "..", "..");
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  for (const file of [
    "src/app/api/micropub/route.ts",
    "src/app/xmlrpc/route.ts",
    "src/app/(public)/post/[slug]/page.tsx",
    "src/app/(public)/about/page.tsx",
  ]) {
    it(`${file} uses the shared renderer`, () => {
      const src = read(file);
      expect(src).toContain("renderMarkdownToSafeHtml");
      expect(src).not.toMatch(/sanitizeHtml\(marked\.parse/);
    });
  }

  it("leaves og.ts alone — it parses WITHOUT sanitising on purpose", () => {
    // It strips the result to plain text for an image caption, so routing it
    // through the sanitiser would be pointless work on a different job.
    expect(read("src/lib/og.ts")).toContain("marked");
  });
});
