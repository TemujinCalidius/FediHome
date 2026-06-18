import { describe, it, expect } from "vitest";
import {
  between,
  allBlocks,
  stripTags,
  extractParam,
  extractStruct,
} from "../xmlrpc";

describe("between", () => {
  it("returns the text between the first matching tag pair", () => {
    expect(between("<a>hello</a>", "a")).toBe("hello");
  });
  it("stops at the first closing tag", () => {
    expect(between("<a>x</a><a>y</a>", "a")).toBe("x");
  });
  it("returns null when the tag is missing or unpaired", () => {
    expect(between("<a>x</a>", "b")).toBeNull();
    expect(between("<a>x without close", "a")).toBeNull();
  });
});

describe("allBlocks", () => {
  it("returns every block's inner text in order", () => {
    expect(allBlocks("<m>1</m><m>2</m><m>3</m>", "m")).toEqual(["1", "2", "3"]);
  });
  it("returns [] when none match", () => {
    expect(allBlocks("<x>1</x>", "m")).toEqual([]);
  });
  it("ignores a trailing unclosed block", () => {
    expect(allBlocks("<m>1</m><m>oops", "m")).toEqual(["1"]);
  });
});

describe("stripTags", () => {
  it("removes tags but keeps text", () => {
    expect(stripTags("<a><b>hi</b> there</a>")).toBe("hi there");
  });
  it("drops a dangling unclosed tag (safer than the old regex)", () => {
    expect(stripTags("ok <broken")).toBe("ok ");
  });
});

describe("extractParam", () => {
  const body = `<methodCall><params>
    <param><value><string>blogid</string></value></param>
    <param><value><string>admin</string></value></param>
    <param><value><string>tok-123</string></value></param>
    <param><value><int>25</int></value></param>
  </params></methodCall>`;

  it("returns the string value at the given index", () => {
    expect(extractParam(body, 2)).toBe("tok-123");
  });
  it("returns a digits-only int value", () => {
    expect(extractParam(body, 3)).toBe("25");
  });
  it("returns '' for an out-of-range index", () => {
    expect(extractParam(body, 9)).toBe("");
  });
  it("tolerates whitespace between <param> and <value>", () => {
    expect(extractParam("<param>\n  <value><string>x</string></value>\n</param>", 0)).toBe("x");
  });
  it("skips <param> elements that carry no <value> (index parity)", () => {
    expect(extractParam("<param></param><param><value><string>real</string></value></param>", 0)).toBe("real");
  });
  it("falls back to stripped text for non-string/int values", () => {
    expect(extractParam("<param><value><dateTime.iso8601>2026-06-18</dateTime.iso8601></value></param>", 0)).toBe("2026-06-18");
  });
  it("ignores a non-numeric <int> body, falling through to stripped text", () => {
    expect(extractParam("<param><value><int>12abc</int></value></param>", 0)).toBe("12abc");
  });
});

describe("extractStruct", () => {
  it("maps member names to their string/int/boolean values", () => {
    const xml = `<struct>
      <member><name>title</name><value><string>Hello</string></value></member>
      <member><name>description</name><value><string>Body text</string></value></member>
      <member><name>count</name><value><int>7</int></value></member>
      <member><name>draft</name><value><boolean>0</boolean></value></member>
    </struct>`;
    expect(extractStruct(xml)).toEqual({
      title: "Hello",
      description: "Body text",
      count: "7",
      draft: "0",
    });
  });
  it("lets an empty <string> fall through to the next typed value", () => {
    const xml = `<member><name>k</name><value><string></string><int>5</int></value></member>`;
    expect(extractStruct(xml).k).toBe("5");
  });
  it("skips members with no name", () => {
    const xml = `<member><value><string>orphan</string></value></member>`;
    expect(extractStruct(xml)).toEqual({});
  });
});

describe("ReDoS resistance", () => {
  it("parses a very large well-formed value in linear time", () => {
    const big = "x".repeat(500_000);
    const xml = `<param><value><string>${big}</string></value></param>`;
    const start = Date.now();
    expect(extractParam(xml, 0)).toBe(big);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("does not backtrack on adversarial unterminated input", () => {
    // The old lazy/greedy regexes backtracked polynomially on inputs full of
    // partial delimiters; the indexOf scan returns immediately.
    const evil = "<param><value>" + "</value>".repeat(100_000);
    const start = Date.now();
    expect(extractParam(evil, 0)).toBe(""); // no </param> → no complete param block
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
