/**
 * Media fields for a post edit. Each is OPTIONAL on purpose (#202): an omitted
 * (undefined) field means "leave the stored media unchanged", so a
 * title/content-only edit can't silently wipe a post's photos/videos/audio. An
 * explicit empty array clears that media.
 */
export interface MediaEditInput {
  photos?: { url: string; alt?: string | null }[];
  videos?: { url: string; title?: string | null; thumbnailUrl?: string | null }[];
  audios?: { url: string; title?: string | null; coverImage?: string | null }[];
}

/**
 * Build the `prisma.post.update` media data from an edit input, INCLUDING a
 * media group only when it was provided. Spread into the update `data`:
 * omitted groups are absent from the object, so Prisma leaves those columns
 * untouched; a provided group (even `[]`) overwrites.
 */
export function buildMediaUpdate(input: MediaEditInput): Record<string, string[]> {
  const data: Record<string, string[]> = {};
  if (input.photos !== undefined) {
    data.photos = input.photos.map((p) => p.url);
    data.photoCaptions = input.photos.map((p) => p.alt || "");
  }
  if (input.videos !== undefined) {
    data.videos = input.videos.map((v) => v.url);
    data.videoTitles = input.videos.map((v) => v.title || "");
    data.videoThumbnails = input.videos.map((v) => v.thumbnailUrl || "");
  }
  if (input.audios !== undefined) {
    data.audioPaths = input.audios.map((a) => a.url);
    data.audioTitles = input.audios.map((a) => a.title || "");
    data.audioCovers = input.audios.map((a) => a.coverImage || "");
  }
  return data;
}
