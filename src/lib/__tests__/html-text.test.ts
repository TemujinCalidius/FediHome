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
});
