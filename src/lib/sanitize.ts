import sanitize from "sanitize-html";

const DANGEROUS_PROTO = /^\s*(javascript|data|vbscript):/i;

const OPTIONS: sanitize.IOptions = {
  allowedTags: [
    "p", "br", "a", "strong", "b", "em", "i", "del", "s",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "code", "pre", "blockquote",
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
