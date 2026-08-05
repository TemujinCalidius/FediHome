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

/**
 * #529. `marked` renders a GFM task list as `<input checked disabled
 * type="checkbox">`. `input` wasn't in `allowedTags`, so the box was deleted and
 * only the label survived — meaning a checked item and an unchecked one came out
 * byte-identical. That is a lost STATE, not a lost decoration, which is what
 * separates it from an ordinary allowlist gap.
 *
 * Asserted against marked's REAL output rather than a hand-written string, the
 * same shape #481 established: a future marked release that changes task-list
 * rendering then fails here loudly instead of silently regressing.
 */
describe("task-list checkboxes survive sanitisation (#529)", () => {
  it("keeps a checked item distinguishable from an unchecked one", async () => {
    const { marked } = await import("marked");
    const html = marked.parse("- [x] done\n- [ ] todo") as string;
    expect(html).toContain("<input");

    const clean = sanitizeHtml(html);
    const [doneItem, todoItem] = clean.split("<li>").slice(1);
    expect(doneItem).toContain("checked");
    expect(todoItem).not.toContain("checked");
    // The failure being fixed, stated directly: the two used to be identical.
    expect(doneItem.replace(" done", "")).not.toBe(todoItem.replace(" todo", ""));
  });

  it("keeps the list itself intact", async () => {
    const { marked } = await import("marked");
    const clean = sanitizeHtml(marked.parse("- [x] done") as string);
    expect(clean).toContain("<ul>");
    expect(clean).toContain("done");
  });
});

/**
 * The other half, as #481 established: widening must not become loosening. This
 * allowlist is not only applied to the owner's own markdown — the SAME options
 * sanitise HTML arriving from arbitrary remote instances, in the inbox,
 * conversation threads, Explore and every FediCard.
 */
describe("the input widening did not become a general loosening (#529)", () => {
  it("drops a submittable input entirely", () => {
    const clean = sanitizeHtml(
      '<input name="x" value="y" formaction="https://evil.example" type="image" src="https://evil.example/p">',
    );
    expect(clean).toBe("");
  });

  it("drops a text box, which attribute-level allowlisting alone would permit", () => {
    expect(sanitizeHtml('<input type="text" disabled>')).toBe("");
  });

  it("drops a checkbox that isn't disabled", () => {
    // Only the exact shape marked emits is accepted; anything else came from
    // somewhere that isn't our own renderer.
    expect(sanitizeHtml('<input type="checkbox">')).toBe("");
  });

  it("strips name, value and formaction from a checkbox that is otherwise fine", () => {
    const clean = sanitizeHtml('<input type="checkbox" disabled name="n" value="v" formaction="https://e.example">');
    expect(clean).toContain("<input");
    expect(clean).not.toContain("name");
    expect(clean).not.toContain("value");
    expect(clean).not.toContain("formaction");
  });

  it("still strips script and event handlers", () => {
    expect(sanitizeHtml("<script>alert(1)</script><p>ok</p>")).not.toContain("script");
    expect(sanitizeHtml('<input type="checkbox" disabled onclick="x()">')).not.toContain("onclick");
  });
});
