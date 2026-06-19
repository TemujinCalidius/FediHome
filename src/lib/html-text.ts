/**
 * Convert HTML to a plain-text preview/snippet.
 *
 * Strips tags in a single linear pass — unlike a one-shot `replace(/<[^>]*>/g)`,
 * which can be defeated by nested/overlapping tags (e.g. `<<b>script>` →
 * `<script>`) and leaves a dangling unclosed `<…` behind. Then collapses
 * whitespace, trims, and optionally truncates with an ellipsis.
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
  const text = out.replace(/\s+/g, " ").trim();
  if (max !== undefined && text.length > max) {
    return text.slice(0, max - 1) + "…";
  }
  return text;
}
