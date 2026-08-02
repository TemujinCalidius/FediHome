import { marked } from "marked";
import { sanitizeHtml } from "./sanitize";

/**
 * Markdown → HTML that is safe to render (#439).
 *
 * The pairing already existed in three places — micropub, xmlrpc and the post
 * page — spelled out identically each time. That is fine while the input is the
 * owner's own article body, but the About page adds a fourth, and a rule spelled
 * out four times is a rule that eventually gets spelled out wrong once.
 *
 * NOT folded in: `renderMarkdown` in compose/route.ts. That is a regex renderer
 * which also link-ifies hashtags, so unifying them would rewrite the HTML of
 * every already-published article. Different job, deliberately left alone.
 *
 * NOT used by og.ts either — that parses WITHOUT sanitising on purpose, because
 * it immediately strips the result to plain text for an image caption.
 */
export function renderMarkdownToSafeHtml(md: string): string {
  return sanitizeHtml(marked.parse(md) as string);
}

/**
 * The About copy an instance ships with, as markdown.
 *
 * Built at READ time from the live identity rather than stored, so "reset to
 * default" keeps tracking the operator's actual address instead of pinning
 * whatever it was on the day they first pressed save. That is the same reason
 * the page used to interpolate `siteConfig.fediAddress` directly.
 *
 * The bio paragraph is included when set, so an operator who has only filled in
 * their bio gets the page they already had.
 */
export function defaultAboutMarkdown(opts: { fediAddress: string; authorBio: string }): string {
  const bio = opts.authorBio.trim();
  return [
    bio || "This is a self-hosted FediHome instance. Edit this page in Admin → Site settings.",
    "",
    "---",
    "",
    "## This Site",
    "",
    "This website is self-hosted and connected to the Fediverse via ActivityPub. " +
      `You can follow at \`${opts.fediAddress}\` from Mastodon, Pixelfed, or any ` +
      "ActivityPub-compatible platform.",
    "",
    // Rewritten from the hardcoded original, which named two specific apps and
    // asserted Micropub is how posts get published. Both are true of SOME
    // instances; neither is true of all, and this text is now the operator's to
    // change anyway.
    "Posts can be written here or from any app that speaks Micropub or " +
      "ActivityPub, and published straight to this site.",
  ].join("\n");
}
