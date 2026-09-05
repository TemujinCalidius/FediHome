import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What `proxyImage` is willing to hand to an image decoder (#596).
 *
 * The gate used to be `contentTypePrefix: "image/"` with SVG excluded — a
 * blocklist wearing a prefix's clothes. It admits every format nobody has
 * thought to exclude, and that is how `image/avif` and `image/heic` reached
 * libheif, on a path where a **federated peer chooses the bytes** and nobody has
 * authenticated. #587 was a libheif flaw reached exactly that way.
 *
 * The decoder is patched as of v1.28.2, so this is defence-in-depth rather than
 * a live hole. It is worth having because the shape of the gate — not that one
 * CVE — is what would let the next one through, and the recent history of
 * libheif advisories is almost entirely in the HEIF/AVIF decoders.
 *
 * TWO ASSERTIONS ON EVERY REFUSAL, and the second is the one that matters:
 * `proxyImage` returned null, AND **sharp was never called**. Returning null
 * after decoding would be no protection at all — the decode is the dangerous
 * part, not the return value.
 */

const { guardedFetch, sharp, writeFile } = vi.hoisted(() => ({
  guardedFetch: vi.fn(),
  sharp: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/safe-fetch", () => ({
  guardedFetch,
  GuardedFetchError: class extends Error {},
}));
vi.mock("sharp", () => ({ default: sharp }));
vi.mock("node:fs/promises", () => ({
  writeFile,
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
}));
vi.mock("@/lib/uploads-dir", () => ({
  remoteMediaCachingEnabled: async () => true,
  fediCacheBudgetBytes: async () => 2048 * 1024 * 1024,
  ensureUploadDir: async () => "/srv/up/fedi/2026/09",
  uploadsRoots: async () => ["/srv/up"],
  uploadsFediDirs: async () => ["/srv/up/fedi"],
  uploadsDir: async () => "/srv/up",
  legacyUploadsDir: () => "/srv/up",
  resolveUploadPath: vi.fn(),
  uploadPathFor: vi.fn(),
  MAX_FEDI_CACHE_MB: 51200,
  DEFAULT_FEDI_CACHE_MB: 2048,
}));

import { proxyImage } from "@/lib/fedi-media";

/** Bytes that really are what they claim, so a refusal can only be the gate. */
const pad = (head: number[]) => Buffer.concat([Buffer.from(head), Buffer.alloc(64)]);

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF = pad([...Buffer.from("GIF89a"), 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
/** RIFF <len> WEBP — the case a naive "ftyp at 4" check could get wrong. */
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
  Buffer.alloc(64),
]);
/** <size> ftyp avif — an ISO base-media container. */
const AVIF = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from("ftypavif"),
  Buffer.alloc(64),
]);
/** Same container, a different brand — the reason we check the family, not the brand. */
const HEIC = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypheic"),
  Buffer.alloc(64),
]);

/** What the remote says it is sending, and what it actually sends. */
const serve = (contentType: string, body: Buffer) =>
  guardedFetch.mockResolvedValue(
    new Response(new Uint8Array(body), { status: 200, headers: { "content-type": contentType } }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  writeFile.mockResolvedValue(undefined);
  // A pass-through re-encoder, so an accepted image takes the normal path.
  sharp.mockReturnValue({
    rotate: () => ({ toBuffer: async () => JPEG }),
  });
});

/** The path written to disk, or null if nothing was written. */
const written = (): string | null =>
  writeFile.mock.calls.length ? String(writeFile.mock.calls[0][0]) : null;

describe("formats the decoder is never handed (#596)", () => {
  // THE TWO LAYERS OVERLAP, AND EACH HAS ITS OWN ISOLATING TEST. These three
  // assert the user-facing property — an AVIF never reaches the decoder — and
  // either layer alone satisfies them, so they do NOT prove the allowlist.
  // "refuses image/avif carrying non-container bytes" isolates the allowlist;
  // "refuses an ISO container even when it claims to be a JPEG" isolates the
  // sniff. Verified by mutation: removing one layer fails exactly its own test.
  it.each([
    ["image/avif", AVIF],
    ["image/heic", HEIC],
    ["image/heif", HEIC],
  ])("refuses %s, and never reaches sharp", async (type, body) => {
    serve(type, body);
    expect(await proxyImage("https://remote.example/x")).toBeNull();
    expect(sharp).not.toHaveBeenCalled();
    expect(written()).toBeNull();
  });

  it("refuses image/avif carrying non-container bytes — the allowlist alone", async () => {
    // Deliberately JPEG bytes under an image/avif label, so the ftyp sniff has
    // nothing to catch. Only the allowlist can refuse this, which is what makes
    // it the allowlist's proof rather than the sniff's.
    serve("image/avif", JPEG);
    expect(await proxyImage("https://remote.example/x.avif")).toBeNull();
    expect(sharp).not.toHaveBeenCalled();
    expect(written()).toBeNull();
  });

  it("refuses an ISO container even when it claims to be a JPEG", async () => {
    // The declared type is chosen by the same remote that chose the bytes, so
    // the allowlist alone is only the honest peer's half.
    serve("image/jpeg", AVIF);
    expect(await proxyImage("https://remote.example/liar.jpg")).toBeNull();
    expect(sharp).not.toHaveBeenCalled();
    expect(written()).toBeNull();
  });

  it("still refuses SVG, which the old prefix gate did handle", async () => {
    // A control: the one exclusion that existed before must not be lost.
    serve("image/svg+xml", pad([0x3c, 0x73, 0x76, 0x67, 0x20, 0x78, 0x6d, 0x6c, 0x6e, 0x73, 0x3d, 0x22]));
    expect(await proxyImage("https://remote.example/x.svg")).toBeNull();
    expect(sharp).not.toHaveBeenCalled();
  });

  it("refuses a type nobody thought about, rather than storing it as .jpg", async () => {
    // The old gate accepted this and wrote it out under a forced `.jpg`,
    // because `extMap` did not name it and `ext` falls back to "jpg".
    serve("image/x-icon", pad([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00]));
    expect(await proxyImage("https://remote.example/favicon.ico")).toBeNull();
    expect(written()).toBeNull();
  });
});

describe("formats that must keep working", () => {
  it("accepts a JPEG and stores it as .jpg", async () => {
    serve("image/jpeg", JPEG);
    const out = await proxyImage("https://remote.example/a.jpg");
    expect(sharp).toHaveBeenCalled();
    expect(out).toMatch(/^\/uploads\/fedi\/\d{4}\/\d{2}\/.+\.jpg$/);
  });

  it("accepts a WebP — RIFF is not an ISO container", async () => {
    // The sniff reads offset 4..8, which for WebP is the little-endian length,
    // not "ftyp". Worth its own test: a careless check would eat every WebP.
    serve("image/webp", WEBP);
    expect(await proxyImage("https://remote.example/a.webp")).toMatch(/\.webp$/);
  });

  it("accepts a PNG", async () => {
    serve("image/png", PNG);
    expect(await proxyImage("https://remote.example/a.png")).toMatch(/\.png$/);
  });

  it("accepts a GIF, and does not re-encode it", async () => {
    // GIFs skip sharp so animation survives — unchanged by this.
    serve("image/gif", GIF);
    expect(await proxyImage("https://remote.example/a.gif")).toMatch(/\.gif$/);
    expect(sharp).not.toHaveBeenCalled();
  });

  it("accepts the non-standard image/jpg spelling", async () => {
    // Reaches us today through the url-extension fallback; an allowlist that
    // omitted it would be a regression for servers that send it.
    serve("image/jpg", JPEG);
    expect(await proxyImage("https://remote.example/a.jpg")).toMatch(/\.jpg$/);
  });

  it("ignores content-type parameters", async () => {
    // `image/jpeg; charset=utf-8` used to miss `extMap` entirely and fall
    // through to guessing the extension from the URL.
    serve("image/jpeg; charset=utf-8", JPEG);
    expect(await proxyImage("https://remote.example/a")).toMatch(/\.jpg$/);
  });
});
