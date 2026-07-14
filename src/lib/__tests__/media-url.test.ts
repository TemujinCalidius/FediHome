import { describe, it, expect, vi } from "vitest";

vi.mock("@/../site.config", () => ({ siteConfig: { url: "https://my.example" } }));

import { localMediaSrc } from "@/lib/media-url";

describe("localMediaSrc (post-image preview fix)", () => {
  it("relativizes a same-origin absolute upload URL so next/image treats it as local", () => {
    expect(localMediaSrc("https://my.example/uploads/2026/07/x.png")).toBe("/uploads/2026/07/x.png");
  });

  it("preserves the query string", () => {
    expect(localMediaSrc("https://my.example/uploads/x.png?v=2")).toBe("/uploads/x.png?v=2");
  });

  it("leaves an already-relative URL unchanged (idempotent)", () => {
    expect(localMediaSrc("/uploads/x.png")).toBe("/uploads/x.png");
  });

  it("leaves a cross-origin (federated/remote) URL absolute — must NOT touch PeerTube/Mastodon media", () => {
    expect(localMediaSrc("https://makertube.net/thumb.jpg")).toBe("https://makertube.net/thumb.jpg");
    expect(localMediaSrc("https://mastodon.social/media/y.png")).toBe("https://mastodon.social/media/y.png");
  });

  it("returns an empty string unchanged", () => {
    expect(localMediaSrc("")).toBe("");
  });
});
