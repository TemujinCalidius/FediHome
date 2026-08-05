import sanitize from "sanitize-html";

const DANGEROUS_PROTO = /^\s*(javascript|data|vbscript):/i;

const OPTIONS: sanitize.IOptions = {
  allowedTags: [
    "p", "br", "a", "strong", "b", "em", "i", "del", "s",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "code", "pre", "blockquote",
    // `hr` (#481): marked renders `---` as <hr>, and every publishing path pairs
    // marked with this allowlist — so the commonest divider in hand-written
    // markdown was stripped after rendering, in article bodies and in imports.
    // It reads as a theme choice rather than a bug, which is why it lasted.
    // Void element, no attributes, no scripting surface.
    "hr",
    "table", "thead", "tbody", "tr", "th", "td",
    "img", "span", "div",
  ],
  allowedAttributes: {
    a: ["href", "rel", "target", "class"],
    img: ["src", "alt", "width", "height", "class"],
    span: ["class"],
    div: ["class"],
    code: ["class"],
    pre: ["class"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedIframeHostnames: [],
  // Strip HTML comments — a known mXSS vector (sanitize-html does this by default)
  exclusiveFilter: (frame) => {
    if (frame.attribs.href && DANGEROUS_PROTO.test(frame.attribs.href)) return true;
    if (frame.attribs.src && DANGEROUS_PROTO.test(frame.attribs.src)) return true;
    return false;
  },
};

export function sanitizeHtml(html: string): string {
  return sanitize(html, OPTIONS);
}

/**
 * Escape plain text for inclusion in HTML.
 *
 * An Article's `name` is plain text, and every ingest path wraps it in an `<h2>`
 * because FediPost has no title column. Lives here rather than beside one of the
 * callers so the ingests can't drift into having *slightly* different ideas of
 * what needs escaping — which is what happened when the Explore resolver (#386)
 * grew its own copy.
 */
export function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
