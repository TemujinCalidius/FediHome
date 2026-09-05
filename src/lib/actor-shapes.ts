/**
 * Reading the parts of a remote actor document we actually use (#591).
 *
 * Every actor fetch in this tree does `const actor = await res.json()` and then
 * treats the result as if it matched `ResolvedFediActor`. It is `any`, it came
 * from somebody else's server, and ActivityStreams 2.0 permits more shapes than
 * the code allows for. Two of those cost us something real.
 *
 * **`icon` may be a single Image OR an array of them.** PeerTube sends the array
 * form — several sizes, small one first. Mastodon, Lemmy and Pixelfed all send a
 * single object, which is why every actor fixture in this repo encodes that
 * shape and why twelve copies of `actor.icon?.url || null` survived review. On
 * an array, `.url` is `undefined`, so the avatar becomes `null`: nothing throws,
 * nothing is logged, and a PeerTube actor simply has no picture, forever. That
 * is not hypothetical here — `next.config.ts` ships ten PeerTube hosts.
 *
 * **`inbox` is declared `string` and was only ever checked for truthiness.** So
 * `inbox: ["https://a/inbox", "https://b/inbox"]` passed the guard and arrived
 * in the delivery layer typed `string`, where a `String()` coercion turns it into
 * `"https://a/inbox,https://b/inbox"` — which parses, with host `a`. Not an
 * SSRF (the outbound call still goes through `guardedFetch`), but a type
 * confusion that surfaces a long way from its cause, in code that signs and
 * POSTs. A two-element inbox is a document we do not understand, and picking the
 * first is guessing which server receives someone's private mention.
 *
 * DEPENDENCY-FREE ON PURPOSE. Three of the twelve call sites are in `scripts/`,
 * which build their own PrismaClient and must not pull in `lib/db`. One of them
 * is the avatar-repair tool: fix the library and leave the script, and the next
 * repair run writes NULL over exactly the rows this was meant to populate.
 */

/** An AS2 value that might be a Link object rather than a bare URL string. */
interface MaybeLink {
  href?: unknown;
  url?: unknown;
}

/**
 * The first http(s) URL in an AS2 `icon` / `image` value, or null.
 *
 * Accepts every shape the specification allows and we have seen in the wild:
 *
 *   "https://x/a.png"                        a bare URL
 *   { url: "https://x/a.png" }               an Image                 (Mastodon)
 *   [ { url: … }, { url: … } ]               an array of Images       (PeerTube)
 *   { url: { href: "https://x/a.png" } }     an Image whose url is a Link
 *   { href: "https://x/a.png" }              a Link in place of an Image
 *
 * **Only `http:` and `https:` are returned.** These values are stored and later
 * rendered as image sources, and a remote server chooses them — so a
 * `javascript:` or `data:` icon has no business being persisted, whatever a
 * browser would currently do with it. Absolute URLs are what AS2 calls for.
 */
export function actorImageUrl(value: unknown): string | null {
  // Arrays first: PeerTube hoists the small variant, so first-usable is also the
  // cheapest to fetch. Recursive, because an entry can be any of the shapes.
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = actorImageUrl(entry);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "string") return httpUrlOrNull(value);

  if (value && typeof value === "object") {
    const v = value as MaybeLink;
    // `url` may itself be a string, a Link, or an array of either.
    if (v.url !== undefined) {
      const fromUrl = actorImageUrl(v.url);
      if (fromUrl) return fromUrl;
    }
    if (typeof v.href === "string") return httpUrlOrNull(v.href);
  }

  return null;
}

/** The string if it parses as an http(s) URL, else null. */
function httpUrlOrNull(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * An actor's `inbox` when it is genuinely a single URL string, else null.
 *
 * `null` means **refuse the actor**, not "try harder". The alternative is
 * choosing on their behalf which of several servers receives their mail, and
 * there is no right answer to guess.
 *
 * The pattern already existed at `account-move.ts:102` and nowhere else; this is
 * that check, shared.
 */
export function actorInboxUrl(value: unknown): string | null {
  return typeof value === "string" ? httpUrlOrNull(value) : null;
}
