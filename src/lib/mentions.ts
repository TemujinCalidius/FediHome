/**
 * Server-side @mention parsing and rendering helpers.
 *
 * Detects @user@domain (fediverse) and @handle.bsky.social (Bluesky) substrings
 * in plain-text content. Looks them up against `FediFollower` + `FediFollowing`
 * (for fedi) or `BlueskyFollower` + `BlueskyFollowing` (for Bluesky) and returns
 * structured records the caller can use to build AP `Mention` tags, extend
 * delivery sets, and render local HTML.
 *
 * The Bluesky crosspost path doesn't need any of this — `RichText` from
 * `@atproto/api` auto-resolves handles to DIDs during `detectFacets`.
 */

import { prisma } from "@/lib/db";

const FEDI_MENTION_RE = /@([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]+)/g;
const BSKY_MENTION_RE = /@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g;

export interface ParsedMention {
  kind: "fedi" | "bluesky";
  handle: string;
  start: number;
  end: number;
  actorUri?: string;
  inbox?: string;
  did?: string;
}

export interface ParsedMentions {
  fedi: ParsedMention[];
  bluesky: ParsedMention[];
}

/**
 * Find all @mentions in `text` and resolve them against the database.
 * Fedi handles are matched first to prevent the Bluesky regex from matching
 * the trailing `@domain` portion of `@user@domain`.
 */
export async function parseMentions(text: string): Promise<ParsedMentions> {
  const fedi: ParsedMention[] = [];
  const bluesky: ParsedMention[] = [];
  // Track character ranges consumed by fedi mentions so Bluesky doesn't double-match
  const consumed: Array<[number, number]> = [];

  // Fedi pass
  FEDI_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FEDI_MENTION_RE.exec(text)) !== null) {
    const username = match[1];
    const domain = match[2];
    const start = match.index;
    const end = start + match[0].length;
    consumed.push([start, end]);

    const follower = await prisma.fediFollower.findFirst({
      where: { username, domain },
      select: { actorUri: true, inbox: true },
    });
    const following = follower
      ? null
      : await prisma.fediFollowing.findFirst({
          where: { username, domain },
          select: { actorUri: true, inbox: true },
        });
    const found = follower || following;
    if (found) {
      fedi.push({
        kind: "fedi",
        handle: `@${username}@${domain}`,
        start,
        end,
        actorUri: found.actorUri,
        inbox: found.inbox,
      });
    }
  }

  // Bluesky pass — skip ranges already consumed by fedi matches
  BSKY_MENTION_RE.lastIndex = 0;
  while ((match = BSKY_MENTION_RE.exec(text)) !== null) {
    const handle = match[1];
    const start = match.index;
    const end = start + match[0].length;
    // Skip if this match is inside any fedi-consumed range
    const overlap = consumed.some(([cs, ce]) => start >= cs && end <= ce);
    if (overlap) continue;

    const follower = await prisma.blueskyFollower.findFirst({
      where: { handle },
      select: { did: true, handle: true },
    });
    const following = follower
      ? null
      : await prisma.blueskyFollowing.findFirst({
          where: { handle },
          select: { did: true, handle: true },
        });
    const found = follower || following;
    if (found) {
      bluesky.push({
        kind: "bluesky",
        handle: `@${found.handle}`,
        start,
        end,
        did: found.did,
      });
    }
  }

  return { fedi, bluesky };
}

/**
 * Wrap @mentions in `html` with anchor tags that point to the right place.
 * Idempotent-ish: if a mention is already inside an `<a>` tag it'll likely be
 * double-wrapped. Call this on plain-text-derived HTML (output of escape + URL
 * autolinker), NOT on already-rendered markdown.
 */
export function linkMentions(html: string, mentions: ParsedMentions): string {
  let out = html;
  // Process fedi first; pick longer matches first so we don't grab a prefix
  const fediSorted = [...mentions.fedi].sort((a, b) => b.handle.length - a.handle.length);
  for (const m of fediSorted) {
    if (!m.actorUri) continue;
    const escaped = m.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped + "(?!@)", "g");
    out = out.replace(
      re,
      `<a href="${m.actorUri}" class="mention" rel="ugc">${m.handle}</a>`,
    );
  }
  const bskySorted = [...mentions.bluesky].sort((a, b) => b.handle.length - a.handle.length);
  for (const m of bskySorted) {
    // The href: bsky.app handles the visible profile URL
    const profileUrl = `https://bsky.app/profile/${m.handle.replace(/^@/, "")}`;
    const escaped = m.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Negative lookahead `(?!\w)` to avoid mid-word matches
    const re = new RegExp(escaped + "(?!\\w|\\.)", "g");
    out = out.replace(
      re,
      `<a href="${profileUrl}" class="mention mention-bsky" rel="ugc">${m.handle}</a>`,
    );
  }
  return out;
}

/**
 * Build the AP `Mention` tag array for a list of fediverse mentions.
 * Bluesky mentions don't get AP tags (Mastodon doesn't understand DIDs).
 */
export function buildApMentionTags(
  mentions: ParsedMentions,
): { type: "Mention"; href: string; name: string }[] {
  return mentions.fedi
    .filter((m) => !!m.actorUri)
    .map((m) => ({ type: "Mention" as const, href: m.actorUri!, name: m.handle }));
}

/**
 * Collect inbox URLs from fediverse mentions for AP delivery.
 * De-duplicates.
 */
export function collectMentionInboxes(mentions: ParsedMentions): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of mentions.fedi) {
    if (m.inbox && !seen.has(m.inbox)) {
      seen.add(m.inbox);
      out.push(m.inbox);
    }
  }
  return out;
}
