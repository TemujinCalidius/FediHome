/**
 * The composer's own markdown renderer, and why it is not `marked` (#529, #530).
 *
 * `renderMarkdownToSafeHtml` in markdown.ts is the shared path for Micropub,
 * XML-RPC and the public pages. This is deliberately NOT folded into it — see
 * the note there: this one also link-ifies hashtags, and every article written
 * in the composer has its output STORED at publish time, so unifying them would
 * rewrite the HTML of everything already published. `linkMentions` also has to
 * run between rendering and sanitising, which the shared helper can't express.
 *
 * Lifted out of `compose/route.ts` so it can be tested at all (#530). It had no
 * tests of any kind: it was a module-private function in a route file, and route
 * files can't export anything but their handlers.
 *
 * **The two renderers agreeing on the same input is the property that keeps them
 * from drifting**, and there is a test asserting it for the case below.
 */

export function linkHashtags(text: string): string {
  return text.replace(
    /#([a-zA-Z0-9_]+)/g,
    '<a href="https://mastodon.social/tags/$1" class="hashtag" rel="tag">#$1</a>'
  );
}

/** Simple markdown to HTML — for article content rendered on site */
export function renderMarkdown(md: string): string {
  let html = md;

  // Code is converted first AND HELD ASIDE, rather than left in the string.
  //
  // "First" was already true; holding it aside is the new half, and it fixes a
  // bug that predates #530. Every pass below is a regex over the whole document,
  // so anything left inside a generated <pre> was still fair game: on `dev`
  // today, ```\n**bold**\n``` renders as `<strong>bold</strong>` INSIDE the code
  // block, and a `---` line anywhere but the first line of a fence already
  // becomes an <hr />. Widening the rule to `***` and `___` would have made that
  // corruption easier to hit, so it gets fixed rather than tested around.
  const held: string[] = [];
  // NUL can't come from a textarea, so a placeholder can never collide with
  // something the author actually typed.
  const hold = (s: string) => `\u0000${held.push(s) - 1}\u0000`;

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const cls = lang ? ` class="language-${lang}"` : "";
    return hold(`<pre><code${cls}>${code.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`);
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${code}</code>`));

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Horizontal rules — BEFORE the emphasis passes, and that ordering is the fix.
  //
  // This was `/^---+$/gm`: only one of CommonMark's three spellings, so `***`
  // and `___` never became a rule (#530). They didn't merely fail to convert —
  // they were published as literal text, because every emphasis regex above
  // requires non-delimiter content between the markers and a bare `***` line has
  // none.
  //
  // And widening it alone would not have been enough. With TWO `***` lines in a
  // document, `/\*\*\*([^*]+)\*\*\*/` pairs them and wraps everything in between
  // in <strong><em> — verified, and worse than the literal text it replaces. So
  // the rule has to be consumed BEFORE emphasis runs, not after it.
  //
  // Still below the code-block pass, or a `---` inside a fence gets eaten.
  html = html.replace(/^(?:-{3,}|\*{3,}|_{3,})$/gm, "<hr />");

  // Bold and italic
  html = html.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/___([^_]+)___/g, "<strong><em>$1</em></strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");

  // Strikethrough
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');

  // Blockquotes
  html = html.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");

  // Hashtags
  html = linkHashtags(html);

  // Put the code back BEFORE paragraphs are decided, so the wrapper's own
  // block-element check below sees a real <pre> and leaves it alone — a
  // placeholder would be treated as prose and wrapped in a <p>, producing
  // <p><pre>. One pass suffices: nothing held contains another placeholder.
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);

  // Paragraphs — wrap remaining text in <p> tags
  html = html
    .split(/\n\n+/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      // Don't wrap blocks that are already HTML block elements
      if (/^<(h[1-6]|pre|blockquote|ul|ol|table|hr|div)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return html;
}
