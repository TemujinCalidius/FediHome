import { siteConfig } from "@/../site.config";
import { htmlToText } from "@/lib/html-text";
import { marked } from "marked";

/** Absolute URL for an asset path (passthrough if already absolute or protocol-relative). */
function abs(u: string): string {
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return `https:${u}`;
  return `${siteConfig.url}${u.startsWith("/") ? "" : "/"}${u}`;
}

type OgPost = {
  coverImage?: string | null;
  photos?: string[];
  audioCovers?: string[];
  contentHtml?: string | null;
  content?: string | null;
  excerpt?: string | null;
};

/**
 * Best preview image for a post's Open Graph / Twitter card, as an absolute URL.
 * Falls through cover → first photo → first inline content image → audio cover →
 * the site default OG image, so the card is never imageless. This is what makes
 * a shared post (Mastodon link card, Bluesky/Threads, Slack/Discord) show a
 * picture even when the post has no explicit cover. (#96)
 */
export function postOgImage(post: OgPost): string {
  // Require whitespace before `src` so we match a real <img src=…> and not a
  // lazy-load `data-src` placeholder.
  const inlineImg = post.contentHtml?.match(/<img[^>]+\ssrc=["']([^"']+)["']/i)?.[1];
  const pick =
    post.coverImage ||
    post.photos?.find(Boolean) ||
    inlineImg ||
    post.audioCovers?.find(Boolean) ||
    siteConfig.ogImagePath;
  return abs(pick);
}

/**
 * Human-readable preview description: an explicit excerpt, else the body with
 * its markup stripped, else `fallback` — never raw markdown. (#96)
 *
 * `fallback` defaults to the site description (for OG/Twitter cards, which must
 * never be imageless/textless). Pass `""` for API list payloads (#253) where a
 * genuinely empty post should stay empty so the client can show its own
 * placeholder rather than the site tagline.
 */
export function postOgDescription(post: OgPost, fallback: string = siteConfig.description): string {
  if (post.excerpt?.trim()) return post.excerpt.trim();
  // Prefer the cached rendered HTML; otherwise render the markdown first so the
  // result is clean text rather than literal `**bold**` / `[text](url)` syntax.
  const html = post.contentHtml || (post.content ? (marked.parse(post.content) as string) : "");
  return htmlToText(html, 200) || fallback;
}
