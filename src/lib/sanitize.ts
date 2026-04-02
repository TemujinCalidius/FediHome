/**
 * Simple HTML sanitizer using an allowlist of safe tags and attributes.
 * Strips everything else to prevent XSS from fedi content or markdown output.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "a", "strong", "b", "em", "i", "del", "s",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "code", "pre", "blockquote",
  "table", "thead", "tbody", "tr", "th", "td",
  "img", "span", "div",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "rel", "target", "class"]),
  img: new Set(["src", "alt", "width", "height", "class"]),
  span: new Set(["class"]),
  div: new Set(["class"]),
  code: new Set(["class"]),
  pre: new Set(["class"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

// Dangerous attribute patterns
const DANGEROUS_ATTR = /^on/i; // onclick, onerror, etc.
const DANGEROUS_PROTO = /^\s*(javascript|data|vbscript):/i;

export function sanitizeHtml(html: string): string {
  // Remove script/style tags and their content entirely
  let clean = html.replace(/<script[\s>][\s\S]*?<\/script>/gi, "");
  clean = clean.replace(/<style[\s>][\s\S]*?<\/style>/gi, "");

  // Process remaining tags
  clean = clean.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)?\/?>/gi, (match, tag, attrs) => {
    const tagLower = tag.toLowerCase();

    // Closing tag
    if (match.startsWith("</")) {
      return ALLOWED_TAGS.has(tagLower) ? `</${tagLower}>` : "";
    }

    // Opening tag — check allowlist
    if (!ALLOWED_TAGS.has(tagLower)) return "";

    // Filter attributes
    const allowedAttrs = ALLOWED_ATTRS[tagLower];
    if (!attrs || !allowedAttrs) {
      const selfClose = match.endsWith("/>") ? " /" : "";
      return `<${tagLower}${selfClose}>`;
    }

    const safeAttrs: string[] = [];
    const attrRegex = /([a-z_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
    let attrMatch;

    while ((attrMatch = attrRegex.exec(attrs)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";

      // Skip event handlers
      if (DANGEROUS_ATTR.test(attrName)) continue;

      // Skip dangerous protocols in href/src
      if ((attrName === "href" || attrName === "src") && DANGEROUS_PROTO.test(attrValue)) continue;

      // Only include allowed attributes
      if (allowedAttrs.has(attrName)) {
        safeAttrs.push(`${attrName}="${attrValue.replace(/"/g, "&quot;")}"`);
      }
    }

    const selfClose = match.endsWith("/>") ? " /" : "";
    const attrStr = safeAttrs.length > 0 ? " " + safeAttrs.join(" ") : "";
    return `<${tagLower}${attrStr}${selfClose}>`;
  });

  return clean;
}
