import { describe, it, expect } from "vitest";
import { htmlToText } from "../html-text";

describe("htmlToText", () => {
  it("strips tags and keeps the text", () => {
    expect(htmlToText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  it("collapses whitespace and trims", () => {
    expect(htmlToText("  <p>a\n\n  b\t c </p> ")).toBe("a b c");
  });

  it("drops a dangling unclosed tag (the incomplete-sanitization gap)", () => {
    // A single `replace(/<[^>]*>/g)` would leave this `<img …` behind.
    expect(htmlToText("safe <img src=x onerror=alert(1)")).toBe("safe");
  });

  it("does not let a <script> survive nested angle brackets", () => {
    expect(htmlToText("<scr<script>ipt>x")).toBe("ipt>x");
    expect(htmlToText("<scr<script>ipt>x")).not.toContain("<script>");
  });

  it("returns '' for tags-only input", () => {
    expect(htmlToText("<br><hr>")).toBe("");
  });

  it("truncates with an ellipsis only when over max", () => {
    expect(htmlToText("abcdefghij", 5)).toBe("abcd…");
    expect(htmlToText("abc", 5)).toBe("abc");
  });

  it("decodes HTML entities so previews don't show them literally", () => {
    expect(htmlToText("<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry");
    expect(htmlToText("it&#39;s a &quot;test&quot;")).toBe(`it's a "test"`);
    expect(htmlToText("<p>&#x27;20 &mdash; &#8217;s</p>")).toBe("'20 &mdash; ’s"); // hex + decimal; unknown named left as-is
    expect(htmlToText("a&nbsp;b")).toBe("a b"); // nbsp → space, then whitespace-collapsed
  });

  it("decodes entities only one level (no eager re-decode of &amp;#39;)", () => {
    expect(htmlToText("&amp;#39;")).toBe("&#39;");
  });

  it("strips tags BEFORE decoding, so a decoded &lt; is not treated as a tag", () => {
    expect(htmlToText("&lt;b&gt;bold&lt;/b&gt;")).toBe("<b>bold</b>");
  });

  it("measures truncation against the decoded text", () => {
    // "&amp;&amp;&amp;" decodes to "&&&" (3 chars) before the 4-char limit applies.
    expect(htmlToText("&amp;&amp;&amp;xy", 4)).toBe("&&&…");
  });
});
