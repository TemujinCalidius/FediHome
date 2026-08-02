import { prisma } from "./db";

/**
 * Content export (#365).
 *
 * FORMAT: NDJSON — one JSON object per line, `_type` naming the record kind.
 * Chosen over a zip for three reasons, all of which the issue names as
 * requirements rather than preferences:
 *
 *  * It STREAMS. The issue is explicit that a multi-GB archive assembled in
 *    memory will OOM a small container, and NDJSON is emitted row by row with
 *    nothing held. A zip needs a compression stream and a new dependency; this
 *    needs neither.
 *  * It is PORTABLE. Every language reads it, `jq` reads it line by line, and a
 *    partially-downloaded file is still valid up to the last newline — which a
 *    truncated zip is not.
 *  * It is APPEND-SHAPED, so a future incremental export is the same code.
 *
 * MEDIA is exported as a MANIFEST, not as bytes — the issue's own minimum. The
 * files are already on the operator's disk under the uploads directory, which
 * they can copy with the tools they already have; what they cannot reconstruct
 * without this is WHICH file belonged to which post, and where it originally
 * came from.
 */

/** Bounded page size. Big enough to be cheap, small enough that nothing piles up. */
const PAGE = 200;

export interface ExportCounts {
  posts: number;
  photos: number;
  videos: number;
  audio: number;
  fediPosts: number;
  comments: number;
}

/**
 * Page through a table by id, emitting each row.
 *
 * Keyed on `id` rather than offset: an export of a live instance runs while
 * posts can still arrive, and OFFSET pagination silently skips or repeats rows
 * when the set shifts underneath it. Cursoring on a stable unique column cannot.
 */
async function* pageBy<T extends { id: string }>(
  find: (cursor: string | null) => Promise<T[]>,
): AsyncGenerator<T> {
  let cursor: string | null = null;
  for (;;) {
    const rows = await find(cursor);
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    if (rows.length < PAGE) return;
    cursor = rows[rows.length - 1].id;
  }
}

/**
 * Prisma narrows `{cursor, skip}` and `{}` to incompatible object types when
 * spread, so this returns one widened shape instead of a union.
 */
const after = (cursor: string | null): { cursor?: { id: string }; skip?: number } =>
  cursor ? { cursor: { id: cursor }, skip: 1 } : {};

/** Every record in the export, in order, as objects ready to be serialised. */
export async function* exportRecords(site: {
  siteUrl: string;
  fediAddress: string;
  version: string;
}): AsyncGenerator<Record<string, unknown>> {
  const counts: ExportCounts = {
    posts: await prisma.post.count(),
    photos: await prisma.photo.count(),
    videos: await prisma.video.count(),
    audio: await prisma.audio.count(),
    fediPosts: await prisma.fediPost.count({ where: { isOutgoing: true } }),
    comments: await prisma.guestComment.count({ where: { status: "approved" } }),
  };

  // Header first, so a consumer knows what it is holding before parsing the
  // rest — and so a truncated download is still self-describing.
  yield {
    _type: "export",
    format: "fedihome-ndjson",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    site,
    counts,
  };

  for await (const r of pageBy((c) =>
    prisma.post.findMany({ take: PAGE, orderBy: { id: "asc" }, ...after(c) }),
  )) yield { _type: "post", ...r };

  for await (const r of pageBy((c) =>
    prisma.photo.findMany({ take: PAGE, orderBy: { id: "asc" }, ...after(c) }),
  )) yield { _type: "photo", ...r };

  for await (const r of pageBy((c) =>
    prisma.video.findMany({ take: PAGE, orderBy: { id: "asc" }, ...after(c) }),
  )) yield { _type: "video", ...r };

  for await (const r of pageBy((c) =>
    prisma.audio.findMany({ take: PAGE, orderBy: { id: "asc" }, ...after(c) }),
  )) yield { _type: "audio", ...r };

  // OUR OWN fediverse posts only. Everything else in that table is other
  // people's content, cached for the timeline — exporting it would hand the
  // operator a pile of strangers' posts under the name "your data".
  for await (const r of pageBy((c) =>
    prisma.fediPost.findMany({
      where: { isOutgoing: true },
      take: PAGE,
      orderBy: { id: "asc" },
      ...after(c),
    }),
  )) yield { _type: "fediPost", ...r };

  // Approved comments only: a pending or rejected one is a moderation decision
  // the operator has not made public, and an export is not the place to.
  for await (const r of pageBy((c) =>
    prisma.guestComment.findMany({
      where: { status: "approved" },
      take: PAGE,
      orderBy: { id: "asc" },
      ...after(c),
    }),
  )) yield { _type: "comment", ...r };
}

/**
 * NDJSON as a stream. Nothing is buffered beyond one page of rows.
 *
 * A failure mid-stream cannot become an HTTP error — the headers are long gone —
 * so it is emitted as a final `_type: "error"` record instead. A consumer that
 * checks the last line can tell a complete export from a truncated one, which a
 * silently-short file would not allow.
 */
export function exportStream(site: {
  siteUrl: string;
  fediAddress: string;
  version: string;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const it = exportRecords(site);
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              _type: "error",
              message: err instanceof Error ? err.message : "export failed",
            }) + "\n",
          ),
        );
        controller.close();
      }
    },
  });
}
