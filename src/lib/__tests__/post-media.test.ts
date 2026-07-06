import { describe, it, expect } from "vitest";
import { buildMediaUpdate } from "@/lib/post-media";

describe("buildMediaUpdate (#202 — omitted media preserved on edit)", () => {
  it("omits every media group when none are provided (title/content-only edit)", () => {
    expect(buildMediaUpdate({})).toEqual({});
    // Nothing to spread → prisma.post.update leaves photos/videos/audio untouched.
  });

  it("writes only the provided groups", () => {
    const data = buildMediaUpdate({ photos: [{ url: "/a.jpg", alt: "A" }] });
    expect(data).toEqual({ photos: ["/a.jpg"], photoCaptions: ["A"] });
    expect(data).not.toHaveProperty("videos");
    expect(data).not.toHaveProperty("audioPaths");
  });

  it("an explicit empty array clears that media group", () => {
    expect(buildMediaUpdate({ photos: [] })).toEqual({ photos: [], photoCaptions: [] });
  });

  it("maps all three groups with parallel caption/title/cover arrays", () => {
    const data = buildMediaUpdate({
      photos: [{ url: "/p.jpg", alt: "cap" }, { url: "/q.jpg" }],
      videos: [{ url: "https://v/1", title: "vid", thumbnailUrl: "/t.jpg" }],
      audios: [{ url: "/a.mp3", title: "song", coverImage: "/c.jpg" }],
    });
    expect(data).toEqual({
      photos: ["/p.jpg", "/q.jpg"],
      photoCaptions: ["cap", ""],
      videos: ["https://v/1"],
      videoTitles: ["vid"],
      videoThumbnails: ["/t.jpg"],
      audioPaths: ["/a.mp3"],
      audioTitles: ["song"],
      audioCovers: ["/c.jpg"],
    });
  });

  it("defaults missing alt/title/thumbnail/cover to empty strings (parallel arrays stay aligned)", () => {
    const data = buildMediaUpdate({
      videos: [{ url: "https://v/1" }],
      audios: [{ url: "/a.mp3" }],
    });
    expect(data.videoTitles).toEqual([""]);
    expect(data.videoThumbnails).toEqual([""]);
    expect(data.audioTitles).toEqual([""]);
    expect(data.audioCovers).toEqual([""]);
  });
});
