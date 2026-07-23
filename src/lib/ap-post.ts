import { getSiteUrl } from "./identity";


const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** An ActivityPub `Image` attachment for a stored image URL (relative or absolute). */
export function imageAttachment(url: string, name = "") {
  const ext = url.split(".").pop()?.toLowerCase() || "jpg";
  return {
    type: "Image",
    mediaType: IMAGE_MIME[ext] || "image/jpeg",
    url: /^https?:\/\//i.test(url) ? url : `${getSiteUrl()}${url}`,
    name,
  };
}

type PostForAp = {
  apId: string | null;
  slug: string;
  title: string | null;
  content: string;
  contentHtml: string | null;
  coverImage?: string | null;
  photos: string[];
  tags: string[];
  publishedAt: Date;
  inReplyTo?: { apId: string | null } | null;
};

/**
 * Canonical ActivityPub object for a stored post — the bare object, WITHOUT an
 * `@context` (callers wrap it in a `Create` or add their own context). Shared by
 * the outbox, the per-post AP route, and the Micropub publish path so all three
 * federate identically. (#96)
 *
 * Notably includes the **cover image** in `attachment` (previously only `photos`
 * were attached, so titled Articles federated imageless) and always uses the
 * rendered `contentHtml` (the Micropub path used to send escaped raw markdown).
 */
export function buildPostObject(post: PostForAp) {
  const attachment = [
    ...(post.coverImage && !post.photos.includes(post.coverImage)
      ? [imageAttachment(post.coverImage)]
      : []),
    ...post.photos.map((url) => imageAttachment(url)),
  ];
  const tag = (post.tags || []).map((t) => ({
    type: "Hashtag",
    href: `https://mastodon.social/tags/${t}`,
    name: `#${t}`,
  }));

  return {
    type: post.title ? "Article" : "Note",
    id: post.apId,
    attributedTo: `${getSiteUrl()}/ap/actor`,
    ...(post.title ? { name: post.title } : {}),
    content: post.contentHtml || `<p>${post.content.replace(/\n/g, "<br>")}</p>`,
    url: `${getSiteUrl()}/post/${post.slug}`,
    published: post.publishedAt.toISOString(),
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${getSiteUrl()}/ap/followers`],
    ...(post.inReplyTo?.apId ? { inReplyTo: post.inReplyTo.apId } : {}),
    ...(attachment.length > 0 ? { attachment } : {}),
    ...(tag.length > 0 ? { tag } : {}),
  };
}
