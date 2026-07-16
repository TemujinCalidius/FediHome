const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode the HTML entities a plain-text preview would otherwise show literally
 * (e.g. `&#39;` → `'`, `&amp;` → `&`). Single `replace` pass, so a
 * double-encoded `&amp;#39;` decodes to `&#39;` (one level), matching HTML
 * semantics rather than eagerly re-decoding. Named set covers what remote
 * Mastodon HTML emits (`& < > " '`); numeric decimal/hex handles everything
 * else (smart quotes, dashes, …). Safe here because the result is a plain-text
 * sink — a decoded `<` is never re-parsed as markup (tags are already stripped).
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (m, code: string) => {
    if (code[0] === "#") {
      const cp =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[code] ?? m;
  });
}

/**
 * Convert HTML to a plain-text preview/snippet.
 *
 * Strips tags in a single linear pass — unlike a one-shot `replace(/<[^>]*>/g)`,
 * which can be defeated by nested/overlapping tags (e.g. `<<b>script>` →
 * `<script>`) and leaves a dangling unclosed `<…` behind. Then decodes HTML
 * entities (so `&#39;`/`&amp;` don't show literally), collapses whitespace,
 * trims, and optionally truncates with an ellipsis. Order matters: tags are
 * stripped BEFORE entities are decoded, so a `&lt;` decoded to `<` is never
 * re-interpreted as a tag.
 *
 * For PLAIN-TEXT sinks only — notification bodies, list snippets, previews.
 * HTML that will actually be rendered must go through `sanitizeHtml` instead.
 */
export function htmlToText(html: string, max?: number): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (!inTag) {
      if (ch === "<") inTag = true;
      else out += ch;
    } else if (ch === ">") {
      inTag = false;
    }
  }
  const text = decodeEntities(out).replace(/\s+/g, " ").trim();
  if (max !== undefined && text.length > max) {
    return text.slice(0, max - 1) + "…";
  }
  return text;
}
