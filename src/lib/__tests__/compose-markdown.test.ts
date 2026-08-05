import { describe, it, expect } from "vitest";
import { renderMarkdown } from "@/lib/compose-markdown";
import { renderMarkdownToSafeHtml } from "@/lib/markdown";

/**
 * The composer's renderer had NO tests of any kind before this (#530). It was a
 * module-private function inside a route file, and route files can't export
 * anything but their handlers — so it was untestable by construction, which is
 * a large part of why a two-year-old gap in it went unnoticed.
 *
 * It is now `src/lib/compose-markdown.ts`. The two renderers stay separate on
 * purpose (see the note at the top of that file and in markdown.ts), so what
 * matters is not that they share code but that they AGREE — the last describe
 * here is the property that keeps them from drifting again.
 */

describe("horizontal rules — all three CommonMark spellings (#530)", () => {
  it.each(["---", "***", "___"])("renders a line of %s as a rule", (rule) => {
    expect(renderMarkdown(`before\n\n${rule}\n\nafter`)).toContain("<hr />");
  });

  it("no longer publishes *** as literal text", () => {
    // The reported symptom: only `---` was recognised, and the other two didn't
    // merely fail to convert — they reached the paragraph wrapper untouched and
    // went out as three literal characters, into what federates to followers.
    const html = renderMarkdown("before\n\n***\n\nafter");
    expect(html).not.toContain("<p>***</p>");
  });

  it("does not turn TWO rule lines into emphasis wrapping everything between", () => {
    // The case the issue misses, and the reason widening the rule alone would
    // not have been enough. `/\*\*\*([^*]+)\*\*\*/` pairs the two markers, so a
    // document with two dividers came out as
    //   a\n\n<strong><em>\n\nb\n\n</em></strong>\n\nc
    // — worse than the literal text. The rule has to be consumed BEFORE the
    // emphasis passes run, not after them.
    const html = renderMarkdown("a\n\n***\n\nb\n\n***\n\nc");
    expect(html).not.toContain("<strong><em>");
    expect(html.match(/<hr \/>/g) ?? []).toHaveLength(2);
  });

  it("leaves a rule inside a fenced code block alone", () => {
    const html = renderMarkdown("```\n---\n***\n```");
    expect(html).not.toContain("<hr />");
    expect(html).toContain("---");
    expect(html).toContain("***");
  });

  it("still emphasises ordinary text, having moved the rule pass above it", () => {
    // The reordering must not cost emphasis anything.
    expect(renderMarkdown("***both***")).toContain("<strong><em>both</em></strong>");
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("___both___")).toContain("<strong><em>both</em></strong>");
    expect(renderMarkdown("_italic_")).toContain("<em>italic</em>");
  });
});

describe("the two renderers agree, which is what stops them drifting (#530)", () => {
  it.each(["---", "***", "___"])("both turn a line of %s into a rule", (rule) => {
    const md = `before\n\n${rule}\n\nafter`;
    expect(renderMarkdown(md)).toContain("<hr");
    // marked has always handled all three; #481 made the result survive
    // sanitisation. The composer was the half that disagreed.
    expect(renderMarkdownToSafeHtml(md)).toContain("<hr");
  });
});

/**
 * A bug that predates #530 and had to be fixed to widen the rule safely.
 *
 * Every pass in this renderer is a regex over the whole document, so anything
 * left inside a generated `<pre>` was still fair game. On `dev` before this,
 * ```\n**bold**\n``` rendered as `<strong>bold</strong>` INSIDE the code block,
 * and a `---` line anywhere but the first line of a fence already became an
 * `<hr />`. Adding `***` and `___` to the rule would have made that easier to
 * hit, so the code is now held aside while the other passes run.
 */
describe("code blocks are inviolate", () => {
  it("does not emphasise markdown inside a fence", () => {
    expect(renderMarkdown("```\n**bold**\n```")).toContain("**bold**");
    expect(renderMarkdown("```\n**bold**\n```")).not.toContain("<strong>");
  });

  it("does not turn a rule inside a fence into an <hr>, wherever it sits", () => {
    // Not the first line — which is the case the old anchored regex could reach.
    const html = renderMarkdown("```js\na\n---\nb\n```");
    expect(html).not.toContain("<hr />");
    expect(html).toContain("---");
  });

  it("does not linkify a hashtag inside a fence", () => {
    expect(renderMarkdown("```\n#nottag\n```")).not.toContain("hashtag");
  });

  it("does not wrap a code block in a paragraph", () => {
    // Restoring before the paragraph pass is what keeps this true — the wrapper
    // recognises `<pre`, and would have wrapped an unrestored placeholder.
    expect(renderMarkdown("```\ncode\n```")).not.toContain("<p><pre>");
  });

  it("still renders inline code, and keeps it out of the emphasis passes", () => {
    expect(renderMarkdown("a `**x**` b")).toContain("<code>**x**</code>");
  });

  it("keeps a fence and ordinary prose in the same document straight", () => {
    const html = renderMarkdown("**real**\n\n```\n**fake**\n```\n\n***\n\nend");
    expect(html).toContain("<strong>real</strong>");
    expect(html).toContain("**fake**");
    expect(html).toContain("<hr />");
  });
});
