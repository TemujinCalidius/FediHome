/**
 * Allowlist HTML sanitiser. Strips disallowed tags/attrs and blocks dangerous
 * URI schemes on href/src — checked AFTER decoding HTML entities, so payloads
 * like `&#x6a;avascript:alert(1)` are caught.
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

const DANGEROUS_ATTR = /^on/i; // onclick, onerror, etc.
const DANGEROUS_PROTO = /^\s*(javascript|data|vbscript):/i;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  Tab: "\t", NewLine: "\n",
};

/**
 * Decode HTML entities so a subsequent scheme check can't be bypassed by
 * encoding the leading character (e.g. `&#x6a;avascript:` → `javascript:`).
 * Covers numeric (`&#NN;` / `&#xHH;`) and a small set of named entities used
 * to express dangerous schemes; full HTML5 entity coverage isn't required for
 * the security check — only the bypass surface.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export function sanitizeHtml(html: string): string {
  // Strip script/style/iframe blocks entirely. The character class includes
  // `/` so self-closing variants (`<script/>…`) are also caught.
  let clean = html.replace(/<script[\s/>][\s\S]*?<\/script>/gi, "");
  clean = clean.replace(/<style[\s/>][\s\S]*?<\/style>/gi, "");
  clean = clean.replace(/<iframe[\s/>][\s\S]*?<\/iframe>/gi, "");

  // Process remaining tags
  clean = clean.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)?\/?>/gi, (match, tag, attrs) => {
    const tagLower = tag.toLowerCase();

    if (match.startsWith("</")) {
      return ALLOWED_TAGS.has(tagLower) ? `</${tagLower}>` : "";
    }

    if (!ALLOWED_TAGS.has(tagLower)) return "";

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

      if (DANGEROUS_ATTR.test(attrName)) continue;

      // Decode entities BEFORE checking for dangerous protocols.
      if (attrName === "href" || attrName === "src") {
        const decoded = decodeEntities(attrValue);
        if (DANGEROUS_PROTO.test(decoded)) continue;
      }

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
