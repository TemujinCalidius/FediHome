import { describe, it, expect } from "vitest";
import { localMediaSrc } from "@/lib/media-url";

describe("localMediaSrc (post-image preview fix)", () => {
  it("relativizes an absolute /uploads URL so next/image treats it as local", () => {
    expect(localMediaSrc("https://my.example/uploads/2026/07/x.png")).toBe("/uploads/2026/07/x.png");
    expect(localMediaSrc("https://my.example/images/avatar.png")).toBe("/images/avatar.png");
  });

  it("is origin-INDEPENDENT — relativizes any host's /uploads path (the client-hydration fix)", () => {
    // Must NOT depend on SITE_URL (unset / different in client bundles): any
    // absolute URL under our media roots relativizes regardless of origin, so a
    // "use client" component (PhotoGrid/HeroSlider) produces the same relative
    // src on the server and after hydration.
    expect(localMediaSrc("https://fedihome.social/uploads/a.png")).toBe("/uploads/a.png");
    expect(localMediaSrc("https://anything.example.org/uploads/b.jpg")).toBe("/uploads/b.jpg");
  });

  it("preserves the query string", () => {
    expect(localMediaSrc("https://my.example/uploads/x.png?v=2")).toBe("/uploads/x.png?v=2");
  });

  it("leaves an already-relative URL unchanged (idempotent)", () => {
    expect(localMediaSrc("/uploads/x.png")).toBe("/uploads/x.png");
  });

  it("leaves a remote/federated URL absolute — its path isn't a local media root", () => {
    expect(localMediaSrc("https://makertube.net/static/thumbnails/x.jpg")).toBe("https://makertube.net/static/thumbnails/x.jpg");
    expect(localMediaSrc("https://mastodon.social/media/y.png")).toBe("https://mastodon.social/media/y.png");
  });

  it("returns an empty string unchanged", () => {
    expect(localMediaSrc("")).toBe("");
  });
});
