import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../sanitize";

describe("sanitizeHtml", () => {
  it("passes clean HTML through", () => {
    const input = "<p>Hello <strong>world</strong></p>";
    expect(sanitizeHtml(input)).toBe("<p>Hello <strong>world</strong></p>");
  });

  it("strips disallowed tags", () => {
    expect(sanitizeHtml("<p>ok</p><script>alert(1)</script>")).toBe("<p>ok</p>");
    expect(sanitizeHtml("<style>body{}</style><p>ok</p>")).toBe("<p>ok</p>");
    expect(sanitizeHtml("<iframe src='evil'></iframe>")).toBe("");
  });

  it("strips event handler attributes", () => {
    expect(sanitizeHtml('<p onclick="evil()">hi</p>')).toBe("<p>hi</p>");
    expect(sanitizeHtml('<img src="ok.png" onerror="evil()">')).toContain('src="ok.png"');
    expect(sanitizeHtml('<img src="ok.png" onerror="evil()">')).not.toContain("onerror");
  });

  it("blocks javascript: protocol in href", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("blocks entity-encoded javascript: protocol", () => {
    expect(sanitizeHtml('<a href="&#x6a;avascript:alert(1)">x</a>')).not.toContain("javascript:");
    expect(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("blocks data: URIs", () => {
    expect(sanitizeHtml('<img src="data:text/html,<script>alert(1)</script>">')).not.toContain(
      "data:"
    );
  });

  it("blocks vbscript: protocol", () => {
    expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).not.toContain("vbscript:");
  });

  it("preserves allowed link attributes", () => {
    const html = '<a href="https://example.com" rel="noopener" target="_blank">link</a>';
    const result = sanitizeHtml(html);
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('rel="noopener"');
    expect(result).toContain('target="_blank"');
  });

  it("strips HTML comments (mXSS vector)", () => {
    expect(sanitizeHtml("<!-- <script>alert(1)</script> --><p>ok</p>")).toBe("<p>ok</p>");
  });

  it("handles noscript foreign-content mXSS pattern", () => {
    // The attacker hopes the noscript boundary causes the parser to break out
    // and emit a live <img onerror=...> tag. sanitize-html contains any
    // onerror= text inside an HTML-encoded attribute value — not executable.
    const payload = "<noscript><p><a href='</noscript><img src=x onerror=alert(1)>'>";
    const result = sanitizeHtml(payload);
    // Must not produce a live <img> or any element with onerror as an attribute
    expect(result).not.toContain("<img");
    // Any onerror text that remains must be HTML-encoded (inside a safe value)
    if (result.includes("onerror")) {
      expect(result).toContain("&lt;");
    }
  });

  it("allows img with safe src", () => {
    const result = sanitizeHtml('<img src="https://cdn.example.com/photo.jpg" alt="photo">');
    expect(result).toContain('src="https://cdn.example.com/photo.jpg"');
  });

  it("allows table structure", () => {
    const html = "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>";
    expect(sanitizeHtml(html)).toBe(html);
  });
});
